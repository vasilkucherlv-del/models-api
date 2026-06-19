require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { pool, norm, init } = require('./db');

const PORT = process.env.PORT || 3000;
const MIN_CHARS = parseInt(process.env.MIN_CHARS || '3', 10);     // мінімум символів для пошуку
const RESULT_CAP = parseInt(process.env.RESULT_CAP || '40', 10);  // стеля видачі (більше → "уточніть")
const PREVIEW_LIMIT = parseInt(process.env.PREVIEW_LIMIT || '12', 10);

// Дозволені домени (звідки можна звертатись до API)
const ALLOWED = [
  'https://lartek.com.ua', 'https://www.lartek.com.ua',
  'https://komplektom.com.ua', 'https://www.komplektom.com.ua',
];

const app = express();
app.set('trust proxy', 1); // за проксі Railway — щоб rate-limit бачив реальний IP
app.use(express.json({ limit: '4mb' }));

app.use(cors({
  origin(origin, cb) {
    // без Origin (curl, сервер-сервер) теж пропускаємо
    if (!origin || ALLOWED.includes(origin)) return cb(null, true);
    return cb(null, false);
  },
}));

// Обмеження частоти лише для публічного пошуку
const limiter = rateLimit({
  windowMs: 60 * 1000, max: 60,
  standardHeaders: true, legacyHeaders: false,
});

app.get('/health', (req, res) => res.send('ok'));

// === Пошук моделей для товару ===
// GET /api/models?sku=DEMO123&q=SMV68
app.get('/api/models', limiter, async (req, res) => {
  try {
    const sku = String(req.query.sku || '').trim();
    if (!sku) return res.status(400).json({ error: 'sku_required' });

    const q = norm(req.query.q);
    if (q.length < MIN_CHARS) return res.json({ tooShort: true, min: MIN_CHARS });

    // беремо на 1 більше за стелю — щоб зрозуміти, чи збігів забагато
    const { rows } = await pool.query(
      `SELECT brand, model FROM compatibility
        WHERE sku = $1 AND model_norm LIKE '%' || $2 || '%'
        ORDER BY model
        LIMIT $3`,
      [sku, q, RESULT_CAP + 1]
    );

    if (rows.length > RESULT_CAP) return res.json({ tooMany: true, cap: RESULT_CAP });
    return res.json({ items: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

// === Прев'ю: невеликий список + загальна кількість ===
// GET /api/preview?sku=DEMO123
app.get('/api/preview', async (req, res) => {
  try {
    const sku = String(req.query.sku || '').trim();
    if (!sku) return res.status(400).json({ error: 'sku_required' });
    const limit = Math.min(parseInt(req.query.limit || PREVIEW_LIMIT, 10) || PREVIEW_LIMIT, 50);

    const items = await pool.query(
      `SELECT brand, model FROM compatibility WHERE sku = $1 ORDER BY model LIMIT $2`,
      [sku, limit]
    );
    const total = await pool.query(
      `SELECT COUNT(*)::int AS n FROM compatibility WHERE sku = $1`, [sku]
    );
    res.json({ total: total.rows[0].n, items: items.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

// === Імпорт даних для товару (захищено ключем) ===
// POST /api/import   headers: X-Import-Key: <IMPORT_KEY>
// body: { "sku":"DEMO123", "replace":true, "models":[{"brand":"Bosch","model":"SMV68IX00D/01"}, ...] }
app.post('/api/import', async (req, res) => {
  if (req.get('X-Import-Key') !== process.env.IMPORT_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const sku = String(req.body.sku || '').trim();
  const models = Array.isArray(req.body.models) ? req.body.models : null;
  const replace = req.body.replace === true;
  if (!sku || !models) return res.status(400).json({ error: 'sku_and_models_required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (replace) await client.query('DELETE FROM compatibility WHERE sku = $1', [sku]);
    let n = 0;
    for (const m of models) {
      const brand = String(m.brand || '').trim();
      const model = String(m.model || '').trim();
      const mn = norm(model);
      if (!brand || !mn) continue;
      await client.query(
        `INSERT INTO compatibility (sku, brand, model, model_norm)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (sku, model_norm)
         DO UPDATE SET brand = EXCLUDED.brand, model = EXCLUDED.model`,
        [sku, brand, model, mn]
      );
      n++;
    }
    await client.query('COMMIT');
    res.json({ sku, processed: n });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  } finally {
    client.release();
  }
});

init()
  .then(() => app.listen(PORT, () => console.log('API на порту ' + PORT)))
  .catch((e) => { console.error('Помилка ініціалізації БД:', e); process.exit(1); });
