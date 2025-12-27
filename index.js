const express = require("express");
const bodyParser = require("body-parser");
const { Pool } = require("pg");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// Financials
const TAX_RATE = 0.05; // 5% example

const subtotalAmount = state.cart.reduce(
  (sum, item) => sum + item.subtotal,
  0
);

const taxAmount = Number((subtotalAmount * TAX_RATE).toFixed(2));
const totalAmount = Number((subtotalAmount + taxAmount).toFixed(2));

/* =======================
   DATABASE CONFIG
   ======================= */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* =======================
   CONSTANTS
   ======================= */
const RESTAURANT_ID = 1; // single restaurant for MVP
const SESSION_EXPIRY_MS = 30 * 60 * 1000; // 30 mins

/* =======================
   IN-MEMORY SESSION STATE
   ======================= */
const userState = {};

/* =======================
   HELPERS
   ======================= */

// Parse "1-3" → { itemNo: 1, qty: 3 }
function parseItemQty(input) {
  const match = input.match(/^(\d+)\s*-\s*(\d+)$/);
  if (!match) return null;

  return {
    itemNo: parseInt(match[1], 10),
    qty: parseInt(match[2], 10)
  };
}

// Build menu text from DB rows
function buildMenuText(menuRows) {
  let text = "Menu 🍽️\n";
  menuRows.forEach(row => {
    text += `${row.item_no}️⃣ ${row.item_name}\n`;
  });
  text += "\nOrder using *itemNo-qty*\nExample: *1-2*";
  return text;
}

/* =======================
   HEALTH CHECK
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

  /* -------- INIT SESSION -------- */
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

  // RESTART / CANCEL
  if (message === "restart" || message === "cancel") {
    delete userState[from];
    reply = "Session cleared ✅\nType *hi* to start again";

    return res.send(`
      <Response>
        <Message>${reply}</Message>
      </Response>
    `);
  }

  // CART
  if (message === "cart") {
    if (state.cart.length === 0) {
      reply = "Your cart is empty 🛒";
    } else {
      reply = "Your cart 🛒:\n";
      state.cart.forEach((i, idx) => {
        reply += `${idx + 1}. ${i.item_name} × ${i.qty}\n`;
      });
      reply += "\nType *confirm* to place order";
    }

    return res.send(`
      <Response>
        <Message>${reply}</Message>
      </Response>
    `);
  }

  // REMOVE ITEM (remove 1)
  if (message.startsWith("remove ")) {
    const idx = parseInt(message.split(" ")[1], 10) - 1;

    if (isNaN(idx) || idx < 0 || idx >= state.cart.length) {
      reply = "Invalid item number to remove ❌";
    } else {
      const removed = state.cart.splice(idx, 1);
      reply = `Removed ${removed[0].item_name} ❌`;
    }

    return res.send(`
      <Response>
        <Message>${reply}</Message>
      </Response>
    `);
  }

  // CONFIRM ORDER
  if (message === "confirm") {
    if (state.cart.length === 0) {
      reply = "Your cart is empty 🛒";
    } else {
      try {
await pool.query(
  `INSERT INTO orders 
   (restaurant_id, phone, items, status,
    subtotal_amount, tax_amount, total_amount)
   VALUES ($1, $2, $3, $4, $5, $6, $7)`,
  [
    RESTAURANT_ID,
    from,
    JSON.stringify(state.cart),
    "NEW",
    subtotalAmount,
    taxAmount,
    totalAmount
  ]
);

        reply =
`Order confirmed 🎉
Thank you for ordering!`;

        delete userState[from];
      } catch (err) {
        console.error(err);
        reply = "Something went wrong. Please try again.";
      }
    }

    return res.send(`
      <Response>
        <Message>${reply}</Message>
      </Response>
    `);
  }

  /* =======================
     START FLOW
     ======================= */
  if (state.step === "START") {
    if (message === "hi" || message === "hello") {
      if (!state.menuShown) {
        const { rows: menuRows } = await pool.query(
          `SELECT item_no, item_name
           FROM menu
           WHERE restaurant_id = $1 AND is_active = true
           ORDER BY item_no`,
          [RESTAURANT_ID]
        );

        reply = buildMenuText(menuRows);
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
     MENU / ORDER INPUT
     ======================= */
  else if (state.step === "MENU") {
    const parsed = parseItemQty(message);

    if (!parsed) {
      reply = "Use format *itemNo-qty* (example: *2-1*)";
    } else {
      const { itemNo, qty } = parsed;

      if (qty <= 0) {
        reply = "Quantity must be at least 1 ❌";
      } else {
        const { rows } = await pool.query(
          `SELECT item_name
           FROM menu
           WHERE restaurant_id = $1
             AND item_no = $2
             AND is_active = true`,
          [RESTAURANT_ID, itemNo]
        );

        if (rows.length === 0) {
          reply = "Invalid item number ❌";
        } else {
          state.cart.push({
            item_no: itemNo,
            item_name: rows[0].item_name,
            qty
          });

          reply =
`Added to cart ✅
${rows[0].item_name} × ${qty}

Add more using *itemNo-qty*
or type *cart* / *confirm*`;
        }
      }
    }
  }

  return res.send(`
    <Response>
      <Message>${reply}</Message>
    </Response>
  `);
});

/* =======================
   SESSION AUTO-CLEANUP
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
