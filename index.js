const express = require("express");
const bodyParser = require("body-parser");
const { Pool } = require("pg");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

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
const RESTAURANT_ID = 1;
const TAX_RATE = 0.05;
const SESSION_EXPIRY_MS = 30 * 60 * 1000;

/* =======================
   SESSION STORE
   ======================= */
const userState = {};

/* =======================
   HELPERS
   ======================= */

// parse "1-2"
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
  const message = (req.body.Body || "").trim().toLowerCase();
  let reply = "";

  /* ---------- INIT SESSION ---------- */
  if (!userState[from]) {
    userState[from] = {
      step: "START",
      cart: [],
      menuShown: false,
      lastActive: Date.now()
    };
  }

  const state = userState[from];
  state.lastActive = Date.now();

  /* =======================
     GLOBAL COMMANDS
     ======================= */

  // restart / cancel
  if (message === "restart" || message === "cancel") {
    delete userState[from];
    reply = "Session cleared ✅\nType *hi* to start again";

    return res.send(`
      <Response><Message>${reply}</Message></Response>
    `);
  }

  // cart
  if (message === "cart") {
    if (state.cart.length === 0) {
      reply = "Your cart is empty 🛒";
    } else {
      reply = "Your cart 🛒:\n";
      state.cart.forEach((i, idx) => {
        reply += `${idx + 1}. ${i.item_name} × ${i.qty} = ₹${i.subtotal}\n`;
      });
      reply += "\nType *confirm* to place order";
    }

    return res.send(`
      <Response><Message>${reply}</Message></Response>
    `);
  }

  // remove item
  if (message.startsWith("remove ")) {
    const index = Number(message.split(" ")[1]) - 1;

    if (isNaN(index) || index < 0 || index >= state.cart.length) {
      reply = "Invalid item number ❌";
    } else {
      const removed = state.cart.splice(index, 1);
      reply = `Removed ${removed[0].item_name} ❌`;
    }

    return res.send(`
      <Response><Message>${reply}</Message></Response>
    `);
  }

  // confirm order
  if (message === "confirm") {
    if (state.cart.length === 0) {
      reply = "Your cart is empty 🛒";
    } else {
      try {
        const subtotalAmount = state.cart.reduce(
          (sum, i) => sum + Number(i.subtotal),
          0
        );

        const taxAmount = Number((subtotalAmount * TAX_RATE).toFixed(2));
        const totalAmount = Number((subtotalAmount + taxAmount).toFixed(2));
        const orderTotalItems = state.cart.reduce(
          (sum, item) => sum + Number(item.qty),
          0
        );

        await pool.query(
          `INSERT INTO orders
           (restaurant_id, phone, items, status, order_total_items,
            subtotal_amount, tax_amount, total_amount)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            RESTAURANT_ID,
            from,
            JSON.stringify(state.cart),
            "NEW",
            orderTotalItems,
            subtotalAmount,
            taxAmount,
            totalAmount
          ]
        );

        reply =
`Order confirmed 🎉
Subtotal: ₹${subtotalAmount}
Tax: ₹${taxAmount}
Total: ₹${totalAmount}`;

        delete userState[from];
      } catch (err) {
        console.error(err);
        reply = "Something went wrong. Please try again.";
      }
    }

    return res.send(`
      <Response><Message>${reply}</Message></Response>
    `);
  }

  /* =======================
     START
     ======================= */
  if (state.step === "START") {
    if (message === "hi" || message === "hello") {
      if (!state.menuShown) {
        const { rows } = await pool.query(
          `SELECT item_no, item_name, price
           FROM menu
           WHERE restaurant_id = $1 AND is_active = true
           ORDER BY item_no`,
          [RESTAURANT_ID]
        );

        reply = buildMenuText(rows);
        state.menuShown = true;
        state.step = "MENU";
      } else {
        reply = "Use *itemNo-qty* or type *cart* / *confirm*";
      }
    } else {
      reply = "Type *hi* to start ordering";
    }
  }

  /* =======================
     MENU INPUT
     ======================= */
  else if (state.step === "MENU") {
    const parsed = parseItemQty(message);

    if (!parsed) {
      reply = "Use format *itemNo-qty* (example: *2-1*)";
    } else {
      const { itemNo, qty } = parsed;

      if (!Number.isInteger(qty) || qty <= 0) {
        reply = "Quantity must be valid ❌";
      } else {
        const { rows } = await pool.query(
          `SELECT item_name, price
           FROM menu
           WHERE restaurant_id = $1
             AND item_no = $2
             AND is_active = true`,
          [RESTAURANT_ID, itemNo]
        );

        if (rows.length === 0) {
          reply = "Invalid item number ❌";
        } else {
          const unitPrice = Number(rows[0].price);
          const itemSubtotal = Number((unitPrice * qty).toFixed(2));

          state.cart.push({
            item_no: itemNo,
            item_name: rows[0].item_name,
            unit_price: unitPrice,
            qty: qty,
            subtotal: itemSubtotal
          });

          reply =
`Added to cart ✅
${rows[0].item_name} × ${qty} = ₹${itemSubtotal}

Add more using *itemNo-qty*
or type *cart* / *confirm*`;
        }
      }
    }
  }

  return res.send(`
    <Response><Message>${reply}</Message></Response>
  `);
});

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
