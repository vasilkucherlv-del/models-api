require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { pool, norm, init } = require('./db');
const { parseFeed } = require('./import-feed');

const PORT = process.env.PORT || 3000;
const MIN_CHARS = parseInt(process.env.MIN_CHARS || '3', 10);     // мінімум символів для пошуку
const RESULT_CAP = parseInt(process.env.RESULT_CAP || '40', 10);  // стеля видачі пошуку (більше → "уточніть")
const BROWSE_CAP = parseInt(process.env.BROWSE_CAP || '500', 10); // стеля перегляду моделей бренду (для лівого списку)
const PREVIEW_LIMIT = parseInt(process.env.PREVIEW_LIMIT || '12', 10);
const FEED_URL = process.env.FEED_URL ||
  'https://www.lartek.com.ua/content/export/def50f4a67a9cdf49099014837c8ba76.xml';

// Дозволені домени (звідки можна звертатись до API)
const ALLOWED = [
  'https://lartek.com.ua', 'https://www.lartek.com.ua',
  'https://komplektom.com.ua', 'https://www.komplektom.com.ua',
  // додаткові домени через змінну EXTRA_ORIGINS (через кому), напр. для тестів/піддоменів
  ...(process.env.EXTRA_ORIGINS || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean),
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

// === Бренди товару + кількість моделей (для випадайки зліва) ===
// GET /api/brands?sku=DEMO123 → { total, brands:[{brand,count}] }
app.get('/api/brands', limiter, async (req, res) => {
  try {
    const sku = String(req.query.sku || '').trim();
    if (!sku) return res.status(400).json({ error: 'sku_required' });
    const { rows } = await pool.query(
      `SELECT brand, COUNT(*)::int AS count
         FROM compatibility WHERE sku = $1
         GROUP BY brand ORDER BY count DESC, brand`,
      [sku]
    );
    const total = rows.reduce((n, r) => n + r.count, 0);
    return res.json({ total, brands: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

// === Пошук / перегляд моделей товару ===
// GET /api/models?sku=DEMO123&q=SMV68            — швидкий пошук по всіх брендах
// GET /api/models?sku=DEMO123&brand=Bosch        — перегляд усіх моделей бренду (лівий список)
// GET /api/models?sku=DEMO123&brand=Bosch&q=SMV  — пошук у межах бренду
app.get('/api/models', limiter, async (req, res) => {
  try {
    const sku = String(req.query.sku || '').trim();
    if (!sku) return res.status(400).json({ error: 'sku_required' });

    const hasBrand = req.query.brand != null;
    const brand = hasBrand ? String(req.query.brand) : null;
    const q = norm(req.query.q);

    // Без бренду і короткий запит — нема що показувати (це швидкий пошук справа).
    if (!hasBrand && q.length < MIN_CHARS) return res.json({ tooShort: true, min: MIN_CHARS });

    const params = [sku];
    let where = 'sku = $1';
    if (hasBrand) { params.push(brand); where += ` AND brand = $${params.length}`; }
    if (q.length >= MIN_CHARS) { params.push(q); where += ` AND model_norm LIKE '%' || $${params.length} || '%'`; }

    // перегляд бренду допускає більше рядків, ніж швидкий пошук
    const cap = hasBrand && q.length < MIN_CHARS ? BROWSE_CAP : RESULT_CAP;
    params.push(cap + 1);
    const { rows } = await pool.query(
      `SELECT brand, model FROM compatibility WHERE ${where} ORDER BY model LIMIT $${params.length}`,
      params
    );

    if (rows.length > cap) return res.json({ tooMany: true, cap });
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

// Пакетний upsert (швидко заливає багато рядків). Дедуп у межах пакета за (sku, model_norm),
// щоб ON CONFLICT не спіткнувся на дублі в одному запиті.
async function upsertRows(client, rows) {
  const seen = new Set();
  const uniq = [];
  for (const r of rows) {
    const key = r.sku + '|' + r.model_norm;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(r);
  }
  const BATCH = 500;
  let n = 0;
  for (let i = 0; i < uniq.length; i += BATCH) {
    const part = uniq.slice(i, i + BATCH);
    const vals = [];
    const params = [];
    part.forEach((r, k) => {
      const b = k * 4;
      vals.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4})`);
      params.push(r.sku, r.brand, r.model, r.model_norm);
    });
    await client.query(
      `INSERT INTO compatibility (sku, brand, model, model_norm)
         VALUES ${vals.join(',')}
         ON CONFLICT (sku, model_norm)
         DO UPDATE SET brand = EXCLUDED.brand, model = EXCLUDED.model`,
      params
    );
    n += part.length;
  }
  return n;
}

// === Наповнення БД прямо з фіду Horoshop (кнопка для не-програміста) ===
// POST /api/import-feed   headers: X-Import-Key: <IMPORT_KEY>
// body (необов'язково): { "sku":"0873", "replace":true }
//   без sku — увесь сайт; replace:true — спершу чистить моделі кожного товару.
app.post('/api/import-feed', async (req, res) => {
  if (req.get('X-Import-Key') !== process.env.IMPORT_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const onlySku = req.body && req.body.sku ? String(req.body.sku).trim() : null;
  const replace = !!(req.body && req.body.replace === true);
  try {
    const r = await fetch(FEED_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept': 'application/xml,text/xml,*/*'
      }
    });
    if (!r.ok) throw new Error('фід недоступний (HTTP ' + r.status + ')');
    const xml = await r.text();
    if (xml.indexOf('<offer') === -1) throw new Error('фід віддав не XML (анти-бот заглушка?)');

    const products = parseFeed(xml, onlySku);
    const rows = [];
    for (const p of products) {
      for (const m of p.models) {
        const mn = norm(m.model);
        if (!mn) continue;                  // бренд може бути порожнім (таблиця без колонки бренду)
        rows.push({ sku: p.sku, brand: m.brand || '', model: m.model, model_norm: mn });
      }
    }

    const client = await pool.connect();
    let ins = 0;
    try {
      await client.query('BEGIN');
      if (replace) {
        const skus = [...new Set(products.map(p => p.sku))];
        for (const s of skus) await client.query('DELETE FROM compatibility WHERE sku = $1', [s]);
      }
      ins = await upsertRows(client, rows);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    res.json({ ok: true, products: products.length, rows: ins, scope: onlySku || 'весь сайт', replace });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Проста сторінка-кнопка (щоб наповнити БД без терміналу).
app.get('/admin', (_req, res) => {
  res.type('html').send(`<!doctype html><html lang="uk"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Сумісні моделі — імпорт</title>
<style>body{font-family:Arial,sans-serif;max-width:560px;margin:40px auto;padding:0 16px;color:#1f2328}
h1{font-size:20px}label{display:block;margin:14px 0 4px;font-weight:700;font-size:14px}
input[type=text],input[type=password]{width:100%;box-sizing:border-box;padding:11px 12px;font-size:15px;border:1px solid #d0d7de;border-radius:8px}
.row{display:flex;align-items:center;gap:8px;margin-top:14px;font-size:14px}
button{margin-top:18px;background:#1f883d;color:#fff;border:0;border-radius:8px;padding:12px 18px;font-size:15px;font-weight:700;cursor:pointer}
button:disabled{opacity:.6;cursor:default}.hint{color:#6b7280;font-size:13px;margin-top:4px}
#out{margin-top:18px;padding:12px;border-radius:8px;white-space:pre-wrap;font-size:14px;display:none}
.ok{background:#eaf6ec;border:1px solid #bfe3c6;color:#1a7f37}.bad{background:#fdecea;border:1px solid #f3c1bb;color:#b42318}</style>
</head><body>
<h1>Наповнити базу сумісних моделей із фіду</h1>
<p class="hint">Ключ — це значення <b>IMPORT_KEY</b> зі змінних сервісу в Railway. Він нікуди не зберігається.</p>
<label>Ключ (IMPORT_KEY)</label>
<input id="key" type="password" autocomplete="off" placeholder="встав ключ">
<label>Артикул товару (необов'язково)</label>
<input id="sku" type="text" autocomplete="off" placeholder="напр. 0873 — залиш порожнім, щоб залити весь сайт">
<div class="row"><input id="replace" type="checkbox"><label style="margin:0;font-weight:400">Спершу очистити старі моделі цих товарів</label></div>
<button id="go">Імпортувати з фіду</button>
<div id="out"></div>
<script>
var go=document.getElementById('go'),out=document.getElementById('out');
go.onclick=function(){
  var key=document.getElementById('key').value.trim();
  var sku=document.getElementById('sku').value.trim();
  var replace=document.getElementById('replace').checked;
  if(!key){alert('Введи ключ');return;}
  go.disabled=true;out.style.display='block';out.className='';out.textContent='Імпортую… (для всього сайту може зайняти кілька хвилин, не закривай сторінку)';
  fetch('/api/import-feed',{method:'POST',headers:{'Content-Type':'application/json','X-Import-Key':key},
    body:JSON.stringify(sku?{sku:sku,replace:replace}:{replace:replace})})
    .then(function(r){return r.json().then(function(d){return {ok:r.ok,d:d};});})
    .then(function(x){
      if(x.ok&&x.d.ok){out.className='ok';out.textContent='Готово ✔\\nТоварів: '+x.d.products+'\\nМоделей залито: '+x.d.rows+'\\nОхоплення: '+x.d.scope;}
      else{out.className='bad';out.textContent='Помилка: '+((x.d&&x.d.error)||'невідома')+(x.d&&x.d.error==='unauthorized'?' (невірний ключ)':'');}
    })
    .catch(function(e){out.className='bad';out.textContent='Помилка з\\'єднання: '+e.message;})
    .finally(function(){go.disabled=false;});
};
</script>
</body></html>`);
});

// === Експорт усієї сумісності (для індексатора Meili: приховане пошукове поле) ===
// GET /api/export            → { count, items:[{ sku, models:[...] }] }
// GET /api/export?sku=0873   → тільки один товар (для пілота)
// Захищено X-Import-Key — щоб повний список не був публічно доступний.
app.get('/api/export', async (req, res) => {
  if (req.get('X-Import-Key') !== process.env.IMPORT_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const sku = String(req.query.sku || '').trim();
    const { rows } = sku
      ? await pool.query('SELECT sku, model FROM compatibility WHERE sku = $1 ORDER BY sku, model', [sku])
      : await pool.query('SELECT sku, model FROM compatibility ORDER BY sku, model');
    const map = new Map();
    for (const r of rows) {
      if (!map.has(r.sku)) map.set(r.sku, []);
      map.get(r.sku).push(r.model);
    }
    const items = Array.from(map, ([sku, models]) => ({ sku, models }));
    res.json({ count: rows.length, items });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

init()
  .then(() => app.listen(PORT, () => console.log('API на порту ' + PORT)))
  .catch((e) => { console.error('Помилка ініціалізації БД:', e); process.exit(1); });
