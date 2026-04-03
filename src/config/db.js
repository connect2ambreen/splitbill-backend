import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';
dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,                        // add this
  idleTimeoutMillis: 30000,       // add this
  connectionTimeoutMillis: 5000,  // add this
  allowExitOnIdle: false,         // keeps pool alive
});

// ── Warm up on startup ──────────────────────────────────────────
// Neon free tier sleeps after 5min inactivity — this pre-wakes it
pool.query('SELECT 1').catch(() => { });

// ── Keep-alive ping every 4 minutes ────────────────────────────
// Prevents Neon from sleeping during active sessions
setInterval(() => {
  pool.query('SELECT 1').catch(() => { });
}, 4 * 60 * 1000);

pool.on('connect', () => console.log('DB connection established'));
pool.on('error', (err) => console.error('Pool error:', err.message));

const query = async (text, params) => {
  try {
    const result = await pool.query(text, params);
    return result;
  } catch (error) {
    console.error('Database query error:', error.message);
    throw error;
  }
};

export { pool, query };