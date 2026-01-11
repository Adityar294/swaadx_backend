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

function parseItemQty(text) {
  const match = text.match(/^(\d+)\s*-\s*(\d+)$/);
  if (!match) return null;

  return {
    itemNo: Number(match[1]),
    qty: Number(match[2])
  };
}

function buildMenuText(rows) {
  let msg = "Menu 🍽️\n";
  rows.forEach(r => {
    msg += `${r.item_no}️⃣ ${r.item_name} - ₹${r.price}\n`;
  });
  msg += "\nOrder using *itemNo-qty*\nExample: *1-2*";
  return msg;
}

async function getRestaurantByWhatsapp(to) {
  const { rows } = await pool.query(
    `SELECT id FROM restaurants WHERE whatsapp_phone = $1`,
    [to]
  );
  return rows[0]?.id;
}
//final

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

  const to = req.body.To;
  const RESTAURANT_ID = await getRestaurantByWhatsapp(to);

  if (!RESTAURANT_ID) {
    return res.send(`
      <Response>
        <Message>This number is not linked to any restaurant.</Message>
      </Response>
    `);
  }

  if (!userState[from]) {
    userState[from] = {
      step: "START",
      cart: [],
      menuShown: false,
      awaitingDeliveryType: false,
      awaitingAddress: false,
      deliveryType: null,
      addressText: null,
      lastActive: Date.now()
    };
  }

  const state = userState[from];
  state.lastActive = Date.now();

  /* ===== GLOBAL COMMANDS ===== */

  if (message === "restart" || message === "cancel") {
    delete userState[from];
    return res.send(`<Response><Message>Session cleared ✅
Type *hi* to start again</Message></Response>`);
  }

  if (message === "cart") {
    if (!state.cart.length) {
      reply = "Your cart is empty 🛒";
    } else {
      reply = "Your cart 🛒:\n";
      state.cart.forEach((i, idx) => {
        reply += `${idx + 1}. ${i.item_name} × ${i.qty} = ₹${i.subtotal}\n`;
      });
      reply += "\nType *confirm* to proceed";
    }
    return res.send(`<Response><Message>${reply}</Message></Response>`);
  }

  if (message.startsWith("remove ")) {
    const index = Number(message.split(" ")[1]) - 1;
    if (isNaN(index) || index < 0 || index >= state.cart.length) {
      reply = "Invalid item number ❌";
    } else {
      const removed = state.cart.splice(index, 1);
      reply = `Removed ${removed[0].item_name} ❌`;
    }
    return res.send(`<Response><Message>${reply}</Message></Response>`);
  }

  /* ===== ADDRESS ===== */

  if (state.awaitingAddress) {
    if (messageRaw.length < 10) {
      reply = "Please enter a complete delivery address.";
    } else {
      state.addressText = messageRaw;
      state.awaitingAddress = false;
      reply = `Address saved ✅
Type *confirm* to place your order`;
    }
    return res.send(`<Response><Message>${reply}</Message></Response>`);
  }

  /* ===== DELIVERY TYPE ===== */

  if (state.awaitingDeliveryType) {
    if (message === "1") {
      state.deliveryType = "delivery";
      state.awaitingDeliveryType = false;
      state.awaitingAddress = true;

      reply = `Please type your full delivery address in ONE message.

Example:
Flat 12, Shanti Apartments,
Near Metro Station,
Andheri West, Mumbai - 400053`;
    } else if (message === "2") {
      state.deliveryType = "pickup";
      state.awaitingDeliveryType = false;
      reply = "Pickup selected ✅\nType *confirm* to place your order";
    } else {
      reply = "Reply with *1* for Delivery or *2* for Pickup";
    }
    return res.send(`<Response><Message>${reply}</Message></Response>`);
  }

  /* ===== CONFIRM ===== */

  if (message === "confirm") {
    if (!state.cart.length) {
      return res.send(`<Response><Message>Your cart is empty 🛒</Message></Response>`);
    }

    if (!state.deliveryType) {
      state.awaitingDeliveryType = true;
      return res.send(`<Response><Message>
How would you like to receive your order?
1️⃣ Delivery
2️⃣ Pickup
</Message></Response>`);
    }

    if (state.deliveryType === "delivery" && !state.addressText) {
      state.awaitingAddress = true;
      return res.send(`<Response><Message>Please enter your delivery address.</Message></Response>`);
    }

    try {
      const subtotal = state.cart.reduce((s, i) => s + i.subtotal, 0);
      const tax = Number((subtotal * TAX_RATE).toFixed(2));
      const total = Number((subtotal + tax).toFixed(2));
      const totalItems = state.cart.reduce((s, i) => s + i.qty, 0);

      await pool.query(
        `INSERT INTO orders
         (restaurant_id, phone, items, order_status,
          delivery_type, address_text,
          order_total_items,
          subtotal_amount, tax_amount, total_amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
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

      reply = `Order confirmed 🎉
Subtotal: ₹${subtotal}
Tax: ₹${tax}
Total: ₹${total}`;

      delete userState[from];
    } catch (err) {
      console.error(err);
      reply = "Something went wrong. Please try again.";
    }

    return res.send(`<Response><Message>${reply}</Message></Response>`);
  }

  /* ===== START / MENU ===== */

  if (state.step === "START") {
    if (message === "hi" || message === "hello") {
      const { rows } = await pool.query(
        `SELECT item_no, item_name, price
         FROM menu
         WHERE restaurant_id=$1 AND is_active=true
         ORDER BY item_no`,
        [RESTAURANT_ID]
      );
      state.step = "MENU";
      reply = buildMenuText(rows);
    } else {
      reply = "Type *hi* to start ordering";
    }
  }

  else if (state.step === "MENU") {
    const parsed = parseItemQty(message);
    if (!parsed) {
      reply = "Use format *itemNo-qty* (example: *2-1*)";
    } else {
      const { itemNo, qty } = parsed;

      const { rows } = await pool.query(
        `SELECT item_name, price
         FROM menu
         WHERE restaurant_id=$1 AND item_no=$2 AND is_active=true`,
        [RESTAURANT_ID, itemNo]
      );

      if (!rows.length) {
        reply = "Invalid item number ❌";
      } else {
        const unit = Number(rows[0].price);
        const subtotal = Number((unit * qty).toFixed(2));

        state.cart.push({
          item_no: itemNo,
          item_name: rows[0].item_name,
          unit_price: unit,
          qty,
          subtotal
        });

        reply = `Added to cart ✅
${rows[0].item_name} × ${qty} = ₹${subtotal}

Add more or type *cart* / *confirm*`;
      }
    }
  }

  res.send(`<Response><Message>${reply}</Message></Response>`);
});

app.get("/dashboard/orders", restaurantAuth, async (req, res) => {
  try {
    const restaurantId = req.restaurant.id;
    const orderStatus = (req.query.status || "").toUpperCase();

    const { rows } = await pool.query(
      `SELECT *
       FROM orders
       WHERE restaurant_id = $1
       AND order_status= $2
       ORDER BY created_at DESC`,
      [restaurantId, orderStatus]
    );

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});


app.post(
  "/dashboard/orders/:id/status/:status",
  restaurantAuth,
  async (req, res) => {
    try {
      const restaurantId = req.restaurant.id;
      const orderId = Number(req.params.id);
      const status = req.params.status;

      console.log("Order ID:", orderId);
      console.log("Status:", status);
      console.log("Restaurant ID:", restaurantId);

      if (!orderId || !status || !restaurantId) {
        return res.status(400).json({ error: "Invalid input" });
      }

      const result = await pool.query(
        `UPDATE orders
         SET order_status = $1
         WHERE id = $2 AND restaurant_id = $3`,
        [status, orderId, restaurantId]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: "Order not found" });
      }

      res.json({ success: true });
    } catch (error) {
      console.error("UPDATE ERROR:", error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  }
);

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

/* =======================
   SESSION CLEANUP
   ======================= */
setInterval(() => {
  const now = Date.now();
  for (const u in userState) {
    if (now - userState[u].lastActive > SESSION_EXPIRY_MS) {
      delete userState[u];
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
// Final