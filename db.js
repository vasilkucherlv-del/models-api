const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const isLocal = (process.env.DATABASE_URL || '').includes('localhost')
            || (process.env.DATABASE_URL || '').includes('127.0.0.1');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway вимагає SSL; локально — ні
  ssl: isLocal ? false : { rejectUnauthorized: false },
});

// Нормалізація коду моделі живе в norm.js (щоб її могли брати й модулі без БД).
// Тут лишається ре-експорт — усі наявні `require('./db').norm` працюють як раніше.
const { norm } = require('./norm');

async function init() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
}

module.exports = { pool, norm, init };
