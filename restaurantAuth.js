const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function restaurantAuth(req, res, next) {
  const token = req.headers["x-dashboard-token"];

  if (!token) {
    return res.status(401).json({ error: "Dashboard token missing" });
  }

  const { rows } = await pool.query(
    "SELECT id, plan, is_cloud_kitchen FROM restaurants WHERE dashboard_token = $1",
    [token]
  );

  if (!rows.length) {
    return res.status(403).json({ error: "Invalid dashboard token" });
  }

  req.restaurant = rows[0]; // VERY IMPORTANT
  next();
}

module.exports = restaurantAuth;
