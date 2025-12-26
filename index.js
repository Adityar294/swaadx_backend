const express = require("express");
const bodyParser = require("body-parser");
const userState = {};

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// Test route
app.get("/", (req, res) => {
  res.send("SwaadX backend running");
});

// WhatsApp webhook
app.post("/whatsapp", (req, res) => {
  const from = req.body.From;
  const message = (req.body.Body || "").trim();

  let reply = "";

  // 1️⃣ Initialize user
  if (!userState[from]) {
    userState[from] = {
      step: "START",
      cart: [],
      currentItem: null
    };
  }

  const state = userState[from];

  // 2️⃣ GLOBAL COMMANDS (PLACE IT HERE 👈)
  if (message.toLowerCase() === "confirm") {
    if (state.cart.length === 0) {
      reply = "Your cart is empty 🛒";
    } else {
      reply = "Order confirmed 🎉";
      delete userState[from]; // reset session
    }

    return res.send(`
      <Response>
        <Message>${reply}</Message>
      </Response>
    `);
  }

  // 3️⃣ STEP-BASED LOGIC STARTS HERE

  // START
  if (state.step === "START") {
    if (message.toLowerCase() === "hi" || message.toLowerCase() === "hello") {
      reply =
`Welcome to SwaadX 🍽️
Menu:
1️⃣ Margherita Pizza
2️⃣ Veg Burger

Reply with item number`;
      state.step = "MENU";
    } else {
      reply = "Type *hi* to start ordering";
    }
  }

  // MENU
  else if (state.step === "MENU") {
    if (message === "1") {
      state.currentItem = "Margherita Pizza";
      state.step = "QTY";
      reply = "How many *Margherita Pizzas* would you like?";
    }
    else if (message === "2") {
      state.currentItem = "Veg Burger";
      state.step = "QTY";
      reply = "How many *Veg Burgers* would you like?";
    }
    else if (message.toLowerCase() === "cart") {
      if (state.cart.length === 0) {
        reply = "Your cart is empty 🛒";
      } else {
        reply = "Your cart 🛒:\n";
        state.cart.forEach((i, idx) => {
          reply += `${idx + 1}. ${i.item} × ${i.qty}\n`;
        });
      }
    }
    else {
      reply = "Reply with *1*, *2*, or type *cart*";
    }
  }

  // QTY
  else if (state.step === "QTY") {
    const qty = parseInt(message);

    if (isNaN(qty) || qty <= 0) {
      reply = "Please enter a valid quantity";
    } else {
      state.cart.push({
        item: state.currentItem,
        qty
      });

      state.currentItem = null;
      state.step = "MENU";

      reply =
`Added to cart ✅
Type item number to add more
or type *cart* to view cart`;
    }
  }

  res.send(`
    <Response>
      <Message>${reply}</Message>
    </Response>
  `);
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {

  console.log("Server running on http://localhost:3000");
});
//testing