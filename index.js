const express = require("express");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// Test route
app.get("/", (req, res) => {
  res.send("SwaadX backend running");
});

// WhatsApp webhook
app.post("/whatsapp", (req, res) => {
  const message = (req.body.Body || "").toLowerCase().trim();

  let reply = "";

  if (message === "hi" || message === "hello") {
    reply = 
`Welcome to SwaadX 🍽️
Please choose an item:
1️⃣ Margherita Pizza
2️⃣ Veg Burger

Reply with item number`;
  } else {
    reply = 
`Sorry, I didn’t understand that 🤔
Type *hi* to start ordering`;
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
