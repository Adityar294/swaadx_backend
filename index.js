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
  const message = req.body.Body;
  console.log("User said:", message);

  res.send(`
    <Response>
      <Message>Hello 👋 Backend is working</Message>
    </Response>
  `);
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {

  console.log("Server running on http://localhost:3000");
});
