const express = require("express");
const bodyParser = require("body-parser");
const { Pool } = require("pg");
const restaurantAuth = require("./restaurantAuth");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

/* =======================
DATABASE
======================= */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* =======================
CONSTANTS
======================= */

const TAX_RATE = 0.05;
const SESSION_EXPIRY_MS = 30 * 60 * 1000;

/* =======================
SESSION STORE
======================= */

const userState = {};

/* =======================
HELPERS
======================= */

function buildMenuText(rows) {
  let msg = "Menu 🍽️\n";

  rows.forEach(r => {
    msg += `${r.item_no}️⃣ ${r.item_name} - ₹${r.price}\n`;
  });

  msg += `

Order using itemNo-qty

Example:
1-2
3-1`;

  return msg;
}

/* Parse multiple items using new lines */

function parseMultipleItems(text) {

  const lines = text.split(/\n|\r/);
  const parsed = [];

  for (let line of lines) {

    line = line.trim();
    if (!line) continue;

    const match = line.match(/^(\d+)\s*-\s*(\d+)$/);
    if (!match) return null;

    parsed.push({
      itemNo: Number(match[1]),
      qty: Number(match[2])
    });

  }

  return parsed.length ? parsed : null;
}

/* Extract restaurant identifier */

function extractRestaurantIdFromMessage(text) {

  const match = text.match(/^order_restro_(\d+)$/i);
  return match ? Number(match[1]) : null;

}

/* =======================
HEALTH
======================= */

app.get("/", (req, res) => {
  res.send("SwaadX backend running");
});

/* =======================
WHATSAPP WEBHOOK
======================= */

app.post("/whatsapp", async (req, res) => {
console.log("Incoming:", message);
  const from = req.body.From;
  const messageRaw = (req.body.Body || "").trim();
  const message = messageRaw.toLowerCase();

  let reply = "";

  /* =======================
  CANCEL / RESET LOGIC
  ======================= */

  if (message.startsWith("cancel")) {

    const parts = message.split(" ");

    // cancel order
    if (parts.length > 1) {

      const orderId = Number(parts[1]);

      if (!orderId) {
        return res.send(`<Response><Message>Invalid format. Use: cancel 123</Message></Response>`);
      }

      const { rows } = await pool.query(
        `SELECT created_at FROM orders WHERE id=$1`,
        [orderId]
      );

      if (!rows.length) {
        return res.send(`<Response><Message>Order not found</Message></Response>`);
      }

      const created = new Date(rows[0].created_at);
      const diff = (Date.now() - created) / 60000;

      if (diff > 10) {
        return res.send(`<Response><Message>Cancel window expired</Message></Response>`);
      }

      await pool.query(
        `UPDATE orders SET order_status='CANCELLED' WHERE id=$1`,
        [orderId]
      );

      return res.send(`<Response><Message>Order cancelled ✅</Message></Response>`);
    }

    // reset session
    delete userState[from];

    return res.send(`<Response><Message>Session cancelled ❌\n\nScan QR again to start</Message></Response>`);
  }

  if (message === "restart" || message === "reset") {

    delete userState[from];

    return res.send(`<Response><Message>Session restarted 🔄\n\nScan QR again</Message></Response>`);
  }

  /* =======================
  SESSION INIT
  ======================= */

  if (!userState[from]) {
    userState[from] = {
      step: "START",
      cart: [],
      awaitingDeliveryType: false,
      awaitingAddress: false,
      deliveryType: null,
      addressText: null,
      restaurantId: null,
      lastActive: Date.now()
    };
  }

  const state = userState[from];
  state.lastActive = Date.now();

  /* =======================
  IDENTIFIER HANDLING
  ======================= */

  if (!state.restaurantId) {

    const extractedId = extractRestaurantIdFromMessage(message);

    if (!extractedId) {
      return res.send(`<Response><Message>Please scan the restaurant QR code to start ordering 📲</Message></Response>`);
    }

    const { rows } = await pool.query(
      `SELECT id,name FROM restaurants WHERE id=$1`,
      [extractedId]
    );

    if (!rows.length) {
      return res.send(`<Response><Message>Invalid restaurant code ❌</Message></Response>`);
    }

    state.restaurantId = extractedId;

    return res.send(`
      <Response>
        <Message>
Welcome to ${rows[0].name} 👋

Type *hi* to see the menu 🍽️
        </Message>
      </Response>
    `);
  }

  const RESTAURANT_ID = state.restaurantId;

  /* =======================
  MENU FLOW
  ======================= */

  if (message === "hi" || message === "menu") {

    const menuRes = await pool.query(
      `SELECT menu_image_url FROM restaurants WHERE id=$1`,
      [RESTAURANT_ID]
    );

    const imageUrl = menuRes.rows[0]?.menu_image_url;

    if (imageUrl) {
      return res.send(`
        <Response>
          <Message>
            <Body>
Menu 🍽️

Order using:
1-2
3-1

You can type anytime:

• cancel → reset ❌  
• restart → fresh 🔄  
• cancel <order_id> → cancel order
            </Body>
            <Media>${imageUrl}</Media>
          </Message>
        </Response>
      `);
    }

    const { rows } = await pool.query(
      `SELECT item_no, item_name, price
       FROM menu
       WHERE restaurant_id=$1 AND is_active=true
       ORDER BY item_no`,
      [RESTAURANT_ID]
    );

    reply = buildMenuText(rows);

    return res.send(`<Response><Message>${reply}</Message></Response>`);
  }

  /* =======================
  CART
  ======================= */

  if (message === "cart") {

    if (!state.cart.length) {
      reply = "Your cart is empty 🛒";
    } else {
      reply = "Your cart 🛒\n";
      state.cart.forEach((i, idx) => {
        reply += `${idx + 1}. ${i.item_name} × ${i.qty} = ₹${i.subtotal}\n`;
      });
      reply += "\nType *confirm* to proceed";
    }

    return res.send(`<Response><Message>${reply}</Message></Response>`);
  }

  /* =======================
  DELIVERY FLOW
  ======================= */

  if (state.awaitingAddress) {
    state.addressText = messageRaw;
    state.awaitingAddress = false;
    return res.send(`<Response><Message>Address saved ✅\nType *confirm*</Message></Response>`);
  }

  if (state.awaitingDeliveryType) {

    if (message === "1") {
      state.deliveryType = "delivery";
      state.awaitingDeliveryType = false;
      state.awaitingAddress = true;
      return res.send(`<Response><Message>Enter delivery address</Message></Response>`);
    }

    if (message === "2") {
      state.deliveryType = "pickup";
      state.awaitingDeliveryType = false;
      return res.send(`<Response><Message>Pickup selected ✅\nType *confirm*</Message></Response>`);
    }

    return res.send(`<Response><Message>Reply 1 or 2</Message></Response>`);
  }

  /* =======================
  CONFIRM
  ======================= */

  if (message === "confirm") {

    if (!state.cart.length) {
      return res.send(`<Response><Message>Your cart is empty</Message></Response>`);
    }

    if (!state.deliveryType) {
      state.awaitingDeliveryType = true;
      return res.send(`<Response><Message>1 Delivery\n2 Pickup</Message></Response>`);
    }

    const subtotal = state.cart.reduce((s, i) => s + i.subtotal, 0);
    const tax = subtotal * TAX_RATE;
    const total = subtotal + tax;

    const orderNoRes = await pool.query(
      `SELECT COALESCE(MAX(restaurant_order_no),0)+1 AS next_no FROM orders WHERE restaurant_id=$1`,
      [RESTAURANT_ID]
    );

    const restaurantOrderNo = orderNoRes.rows[0].next_no;

    const result = await pool.query(
      `INSERT INTO orders
      (restaurant_id, phone, items, order_status,
       delivery_type, address_text,
       order_total_items,
       subtotal_amount, tax_amount, total_amount,
       restaurant_order_no)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING id`,
      [
        RESTAURANT_ID,
        from,
        JSON.stringify(state.cart),
        "NEW",
        state.deliveryType,
        state.addressText,
        state.cart.length,
        subtotal,
        tax,
        total,
        restaurantOrderNo
      ]
    );

    delete userState[from];

    return res.send(`<Response><Message>Order placed ✅\nOrder ID: ${result.rows[0].id}</Message></Response>`);
  }

  /* =======================
  ITEM ADD
  ======================= */

  const parsed = parseMultipleItems(message);

  if (parsed) {

    for (const p of parsed) {

      const { rows } = await pool.query(
        `SELECT item_name, price FROM menu WHERE restaurant_id=$1 AND item_no=$2`,
        [RESTAURANT_ID, p.itemNo]
      );

      if (!rows.length) {
        return res.send(`<Response><Message>Invalid item ${p.itemNo}</Message></Response>`);
      }

      const price = rows[0].price;
      const subtotal = price * p.qty;

      state.cart.push({
        item_name: rows[0].item_name,
        qty: p.qty,
        subtotal
      });
    }

    return res.send(`<Response><Message>Added to cart ✅\nType cart or confirm</Message></Response>`);
  }

  return res.send(`<Response><Message>Type *menu* to see menu</Message></Response>`);
  console.log("Reached end fallback");
});
/* =======================
DASHBOARD APIs
======================= */

app.get("/dashboard/me", restaurantAuth, async (req, res) => {

  const restaurantId = req.restaurant.id;

  const { rows } = await pool.query(
    `SELECT id, name, plan, is_cloud_kitchen
     FROM restaurants
     WHERE id = $1`,
    [restaurantId]
  );

  res.json(rows[0]);

});


app.get("/dashboard/orders", restaurantAuth, async (req, res) => {

  const restaurantId = req.restaurant.id;
  const statusRaw = req.query.status;

  if (!statusRaw) {
    return res.status(400).json({ error: "status query param required" });
  }

  const orderStatus = statusRaw.trim().toUpperCase();

  const { rows } = await pool.query(
    `SELECT *
     FROM orders
     WHERE restaurant_id = $1
     AND order_status = $2
     ORDER BY created_at ASC`,
    [restaurantId, orderStatus]
  );

  res.json(rows);

});


app.post(
  "/dashboard/orders/:id/status/:status",
  restaurantAuth,
  async (req, res) => {

    const restaurantId = req.restaurant.id;
    const orderId = Number(req.params.id);
    const status = req.params.status;

    const result = await pool.query(
      `UPDATE orders
       SET order_status = $1
       WHERE id = $2 AND restaurant_id = $3`,
      [status, orderId, restaurantId]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: "Order not found" });
    }

    res.json({ success: true });

  }
);
/* =======================
SESSION CLEANUP
======================= */

setInterval(() => {

  const now = Date.now();

  for (const user in userState) {

    if (now - userState[user].lastActive > SESSION_EXPIRY_MS) {
      delete userState[user];
    }

  }

}, 5 * 60 * 1000);

/* =======================
START SERVER
======================= */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});