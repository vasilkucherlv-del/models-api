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

// Нормалізація коду моделі: великі літери, лише A-Z0-9.
// ВАЖЛИВО: точно така сама нормалізація має бути у фронтенді,
// щоб пошук "SMV68" знаходив "SMV68IX00D/01".
function norm(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

async function init() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
}

module.exports = { pool, norm, init };
