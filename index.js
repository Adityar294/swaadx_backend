const express = require("express");
const bodyParser = require("body-parser");
const { Pool } = require("pg");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

/* =======================
   DATABASE CONFIG
   ======================= */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* =======================
   IN-MEMORY USER STATE
   ======================= */
const userState = {};

/* =======================
   MENU CONFIG
   ======================= */
const MENU = {
  1: "Margherita Pizza",
  2: "Veg Burger"
};

/* =======================
   HELPER: PARSE 1-3 FORMAT
   ======================= */
function parseItemQty(input) {
  const match = input.match(/^(\d+)\s*-\s*(\d+)$/);
  if (!match) return null;

  return {
    itemNo: parseInt(match[1]),
    qty: parseInt(match[2])
  };
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

  /* -------- INIT USER -------- */
  if (!userState[from]) {
    userState[from] = {
      step: "START",
      cart: []
    };
  }

  const state = userState[from];

  /* -------- GLOBAL: CONFIRM -------- */
  if (message === "confirm") {
    if (state.cart.length === 0) {
      reply = "Your cart is empty 🛒";
    } else {
      try {
        await pool.query(
          `INSERT INTO orders (phone, items, status, order_total_items)
           VALUES ($1, $2, $3, $4)`,
          [
            from,
            JSON.stringify(state.cart),
            "NEW",
            state.cart.reduce((sum, i) => sum + i.qty, 0)
          ]
        );

        reply = "Order confirmed 🎉 Thank you!";
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

  /* -------- GLOBAL: CART -------- */
  if (message === "cart") {
    if (state.cart.length === 0) {
      reply = "Your cart is empty 🛒";
    } else {
      reply = "Your cart 🛒:\n";
      state.cart.forEach((i, idx) => {
        reply += `${idx + 1}. ${i.item} × ${i.qty}\n`;
      });
      reply += "\nType *confirm* to place order";
    }

    return res.send(`
      <Response>
        <Message>${reply}</Message>
      </Response>
    `);
  }

  /* -------- START -------- */
  if (state.step === "START") {
    if (message === "hi" || message === "hello") {
      reply =
`Welcome to SwaadX 🍽️
Menu:
1️⃣ Margherita Pizza
2️⃣ Veg Burger

Order using format:
*1-3*  (item-quantity)`;

      state.step = "MENU";
    } else {
      reply = "Type *hi* to start ordering";
    }
  }

  /* -------- MENU / ORDER INPUT -------- */
  else if (state.step === "MENU") {
    const parsed = parseItemQty(message);

    if (!parsed) {
      reply = "Use format *1-3* (item-quantity)";
    } else {
      const itemName = MENU[parsed.itemNo];

      if (!itemName) {
        reply = "Invalid item number ❌";
      } else if (parsed.qty <= 0) {
        reply = "Quantity must be at least 1 ❌";
      } else {
        state.cart.push({
          item: itemName,
          qty: parsed.qty
        });

        reply =
`Added to cart ✅
${itemName} × ${parsed.qty}

Add more items using *1-2*
or type *cart* / *confirm*`;
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
   START SERVER
   ======================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
