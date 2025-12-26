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
  const from = req.body.From; // user's WhatsApp number
  const message = (req.body.Body || "").trim();

  let reply = "";

  // If user is new, initialize state
  if (!userState[from]) {
    userState[from] = { step: "START" };
  }

  const step = userState[from].step;

  // STEP 1: Start
  if (step === "START") {
    if (message.toLowerCase() === "hi" || message.toLowerCase() === "hello") {
      reply =
`Welcome to SwaadX 🍽️
Please choose an item:
1️⃣ Margherita Pizza
2️⃣ Veg Burger

Reply with item number`;

      userState[from].step = "MENU";
    } else {
      reply = `Type *hi* to start ordering`;
    }
  }

  // STEP 2: Menu selection
  else if (step === "MENU") {
    if (message === "1") {
      reply = `Great choice 😄
How many *Margherita Pizzas* would you like?`;

      userState[from] = {
        step: "QTY",
        item: "Margherita Pizza"
      };
    } 
    else if (message === "2") {
      reply = `Nice 👍
How many *Veg Burgers* would you like?`;

      userState[from] = {
        step: "QTY",
        item: "Veg Burger"
      };
    } 
    else {
      reply = `Please reply with *1* or *2*`;
    }
  }

  // STEP 3: Quantity (we'll expand later)
  else if (step === "QTY") {
    reply = `You selected ${message} ${userState[from].item}(s).
(Type *hi* to restart)`;

    userState[from] = { step: "START" };
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
