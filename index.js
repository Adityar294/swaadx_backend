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

  const from = req.body.From;
  const messageRaw = (req.body.Body || "").trim();
  const message = messageRaw.toLowerCase();

  let reply = "";

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

      return res.send(`
        <Response>
          <Message>Please scan the restaurant QR code to start ordering 📲</Message>
        </Response>
      `);

    }

    const { rows } = await pool.query(
      `SELECT id,name FROM restaurants WHERE id=$1`,
      [extractedId]
    );

    if (!rows.length) {

      return res.send(`
        <Response>
          <Message>Invalid restaurant code ❌</Message>
        </Response>
      `);

    }

    state.restaurantId = extractedId;

    return res.send(`
      <Response>
        <Message>Welcome to ${rows[0].name} 👋
Type *hi* to see the menu 🍽️</Message>
      </Response>
    `);

  }

  const RESTAURANT_ID = state.restaurantId;

  /* =======================
  GLOBAL COMMANDS
  ======================= */

  if (message === "restart" || message === "cancel session") {

    delete userState[from];

    return res.send(`
      <Response>
        <Message>Session cleared. Type *hi* to start again.</Message>
      </Response>
    `);

  }

  if (message === "cart") {

    if (!state.cart.length) {

      reply = "Your cart is empty 🛒";

    } else {

      reply = "Your cart 🛒\n";

      state.cart.forEach((item, index) => {
        reply += `${index + 1}. ${item.item_name} × ${item.qty} = ₹${item.subtotal}\n`;
      });

      reply += "\nType *confirm* to proceed";

    }

    return res.send(`<Response><Message>${reply}</Message></Response>`);

  }

  /* =======================
  ADDRESS
  ======================= */

  if (state.awaitingAddress) {

    if (messageRaw.length < 10) {

      reply = "Please enter a complete address";

    } else {

      state.addressText = messageRaw;
      state.awaitingAddress = false;

      reply = "Address saved ✅\nType *confirm* to place order";

    }

    return res.send(`<Response><Message>${reply}</Message></Response>`);

  }

  /* =======================
  DELIVERY TYPE
  ======================= */

  if (state.awaitingDeliveryType) {

    if (message === "1") {

      state.deliveryType = "delivery";
      state.awaitingDeliveryType = false;
      state.awaitingAddress = true;

      reply = "Please enter delivery address";

    }

    else if (message === "2") {

      state.deliveryType = "pickup";
      state.awaitingDeliveryType = false;

      reply = "Pickup selected ✅\nType *confirm*";

    }

    else {

      reply = "Reply with 1 for Delivery or 2 for Pickup";

    }

    return res.send(`<Response><Message>${reply}</Message></Response>`);

  }

  /* =======================
  CONFIRM ORDER
  ======================= */

  if (message === "confirm") {

    if (!state.cart.length) {

      return res.send(`<Response><Message>Your cart is empty</Message></Response>`);

    }

    if (!state.deliveryType) {

      state.awaitingDeliveryType = true;

      return res.send(`
        <Response>
          <Message>
1️⃣ Delivery
2️⃣ Pickup
          </Message>
        </Response>
      `);

    }

    if (state.deliveryType === "delivery" && !state.addressText) {

      state.awaitingAddress = true;

      return res.send(`<Response><Message>Please enter delivery address</Message></Response>`);

    }

    try {

      const subtotal = state.cart.reduce((s, i) => s + i.subtotal, 0);
      const tax = Number((subtotal * TAX_RATE).toFixed(2));
      const total = Number((subtotal + tax).toFixed(2));
      const totalItems = state.cart.reduce((s, i) => s + i.qty, 0);

      const result = await pool.query(
        `INSERT INTO orders
        (restaurant_id,phone,items,order_status,delivery_type,address_text,
        order_total_items,subtotal_amount,tax_amount,total_amount)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        RETURNING id`,
        [
          RESTAURANT_ID,
          from,
          JSON.stringify(state.cart),
          "NEW",
          state.deliveryType,
          state.addressText,
          totalItems,
          subtotal,
          tax,
          total
        ]
      );

      const orderId = result.rows[0].id;

      /* =======================
      RESTAURANT NOTIFICATION
      (COMMENTED UNTIL GUPSHUP SETUP)
      ======================= */

      /*
      const restro = await pool.query(
        `SELECT phone FROM restaurants WHERE id=$1`,
        [RESTAURANT_ID]
      );

      const restroPhone = restro.rows[0].phone;

      sendWhatsappMessage(restroPhone, `New order ${orderId}`);
      */

      reply = `Order confirmed 🎉

Order ID: ${orderId}
Total: ₹${total}

You can cancel within 10 minutes using:
cancel ${orderId}`;

      delete userState[from];

    } catch (err) {

      console.error(err);
      reply = "Something went wrong";

    }

    return res.send(`<Response><Message>${reply}</Message></Response>`);

  }

  /* =======================
  CANCEL ORDER
  ======================= */

  if (message.startsWith("cancel")) {

    const parts = message.split(" ");
    const orderId = Number(parts[1]);

    const { rows } = await pool.query(
      `SELECT created_at FROM orders WHERE id=$1`,
      [orderId]
    );

    if (!rows.length) {

      return res.send(`<Response><Message>Order not found</Message></Response>`);

    }

    const created = new Date(rows[0].created_at);
    const now = new Date();

    const diff = (now - created) / 60000;

    if (diff > 10) {

      return res.send(`<Response><Message>Cancel window expired</Message></Response>`);

    }

    await pool.query(
      `UPDATE orders SET order_status='CANCELLED' WHERE id=$1`,
      [orderId]
    );

    return res.send(`<Response><Message>Order cancelled</Message></Response>`);

  }

  /* =======================
  MENU FLOW
  ======================= */

  if (message === "hi" || message === "menu") {

    const { rows } = await pool.query(
      `SELECT item_no,item_name,price
      FROM menu
      WHERE restaurant_id=$1 AND is_active=true
      ORDER BY item_no`,
      [RESTAURANT_ID]
    );

    reply = buildMenuText(rows);

    return res.send(`<Response><Message>${reply}</Message></Response>`);

  }

  /* =======================
  ITEM ADDING
  ======================= */

  const parsedItems = parseMultipleItems(message);

  if (parsedItems) {

    for (const p of parsedItems) {

      const { rows } = await pool.query(
        `SELECT item_name,price
        FROM menu
        WHERE restaurant_id=$1 AND item_no=$2`,
        [RESTAURANT_ID, p.itemNo]
      );

      if (!rows.length) {

        return res.send(`<Response><Message>Invalid item ${p.itemNo}</Message></Response>`);

      }

      const unit = Number(rows[0].price);
      const subtotal = Number((unit * p.qty).toFixed(2));

      state.cart.push({
        item_no: p.itemNo,
        item_name: rows[0].item_name,
        unit_price: unit,
        qty: p.qty,
        subtotal
      });

    }

    reply = "Items added to cart ✅\nType *cart* or *confirm*";

    return res.send(`<Response><Message>${reply}</Message></Response>`);

  }

  reply = "Type *menu* to see menu";

  res.send(`<Response><Message>${reply}</Message></Response>`);

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