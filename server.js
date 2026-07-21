require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { pool, norm, init } = require('./db');
const { parseFeed } = require('./import-feed');
const { parseTables } = require('./table-parser');

const PORT = process.env.PORT || 3000;
const MIN_CHARS = parseInt(process.env.MIN_CHARS || '3', 10);     // мінімум символів для пошуку
const RESULT_CAP = parseInt(process.env.RESULT_CAP || '40', 10);     // стеля видачі пошуку (більше → "уточніть")
const BROWSE_PAGE = parseInt(process.env.BROWSE_PAGE || '100', 10);     // порція довантаження списку бренду при прокрутці
const BROWSE_RATIO = parseFloat(process.env.BROWSE_RATIO || '0.6');     // частка списку бренду, доступна для перегляду (решта — лише через пошук)
const BROWSE_MAX = parseInt(process.env.BROWSE_MAX || '500', 10);       // абсолютна стеля рядків перегляду (щоб не роздувати сторінку)
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

// Перевірка ключів. Головний IMPORT_KEY відкриває все; MANAGER_KEY (необов'язкова
// змінна) — лише додавання моделей до окремого товару (розділи 1 і 1б на /admin),
// без масових/руйнівних операцій. Якщо MANAGER_KEY не задано — діє лише головний.
function hasFullKey(req) {
  return req.get('X-Import-Key') === process.env.IMPORT_KEY;
}
function hasManagerKey(req) {
  if (hasFullKey(req)) return true;
  const mk = process.env.MANAGER_KEY;
  return !!mk && req.get('X-Import-Key') === mk;
}

// Роль ключа — щоб сторінка /admin показувала лише дозволені розділи.
// 'full' — усе; 'manager' — лише додавання моделей (1 і 1б); 'none' — нічого.
app.get('/api/keyinfo', (req, res) => {
  if (hasFullKey(req)) return res.json({ role: 'full' });
  if (hasManagerKey(req)) return res.json({ role: 'manager' });
  res.json({ role: 'none' });
});

// Список УСІХ артикулів, що мають моделі в базі (для звірки з експортом сайту).
// Легкий: лише distinct sku. Приймає обидва ключі.
app.get('/api/skus', async (req, res) => {
  if (!hasManagerKey(req)) return res.status(401).json({ error: 'unauthorized' });
  try {
    const { rows } = await pool.query('SELECT DISTINCT sku FROM compatibility ORDER BY sku');
    res.json({ count: rows.length, skus: rows.map(r => r.sku) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

// === Аналітика пошуку ===
// POST /api/search-log { q, hits, source }  — публічний прийом логів із сайту.
// Захищений лише перевіркою довжини; ніколи не ламає сайт (завжди 204).
app.post('/api/search-log', async (req, res) => {
  try {
    const q = String((req.body && req.body.q) || '').trim().replace(/\s+/g, ' ').slice(0, 120);
    if (q.length < 2) return res.status(204).end();
    const hits = Math.max(0, parseInt((req.body && req.body.hits) || 0, 10) || 0);
    const source = String((req.body && req.body.source) || 'site').slice(0, 20);
    await pool.query(
      'INSERT INTO search_log (q, q_norm, hits, source) VALUES ($1,$2,$3,$4)',
      [q, q.toLowerCase(), hits, source]
    );
  } catch (e) { /* тихо: лог не має впливати на сайт */ }
  res.status(204).end();
});

// POST /api/search-click { q, sku }  — клік на результат пошуку (перехід на товар).
app.post('/api/search-click', async (req, res) => {
  try {
    const q = String((req.body && req.body.q) || '').trim().replace(/\s+/g, ' ').toLowerCase().slice(0, 120);
    if (q.length < 2) return res.status(204).end();
    const sku = String((req.body && req.body.sku) || '').trim().slice(0, 60);
    await pool.query('INSERT INTO search_click (q_norm, sku) VALUES ($1,$2)', [q, sku]);
  } catch (e) { /* тихо */ }
  res.status(204).end();
});

// GET /api/search-stats?days=30&limit=50&min=2  — очищений звіт.
// Список «без результатів» фільтрується: довжина ≥ 3, повторів ≥ min (відсіює
// разові одруківки) і без «опрацьованих». Так не доводиться гортати сміття.
app.get('/api/search-stats', async (req, res) => {
  if (!hasManagerKey(req)) return res.status(401).json({ error: 'unauthorized' });
  const days = Math.min(Math.max(parseInt(req.query.days || '30', 10) || 30, 1), 365);
  const lim = Math.min(Math.max(parseInt(req.query.limit || '50', 10) || 50, 1), 200);
  const min = Math.min(Math.max(parseInt(req.query.min || '2', 10) || 2, 1), 50);
  try {
    const since = `now() - interval '${days} days'`;
    const agg = await pool.query(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE hits = 0)::int AS zero
         FROM search_log WHERE created_at >= ${since}`);
    const total = agg.rows[0].total, zeroCnt = agg.rows[0].zero;
    const zeroRate = total ? Math.round(zeroCnt * 100 / total) : 0;
    const clicksRow = await pool.query(`SELECT count(*)::int AS n FROM search_click WHERE created_at >= ${since}`);
    // Запити, що ДАЛИ результати, шукались ≥ min, але жодного кліку — видача нерелевантна.
    const noClick = await pool.query(
      `SELECT q_norm AS q, count(*)::int AS cnt
         FROM search_log s
        WHERE created_at >= ${since} AND hits > 0 AND char_length(q_norm) >= 3
          AND q_norm NOT IN (SELECT q_norm FROM search_dismissed)
          AND q_norm NOT IN (SELECT q_norm FROM search_click WHERE created_at >= ${since})
        GROUP BY q_norm HAVING count(*) >= $1 ORDER BY cnt DESC, q_norm LIMIT $2`, [min, lim]);
    const top = await pool.query(
      `SELECT q_norm AS q, count(*)::int AS cnt, max(hits)::int AS max_hits
         FROM search_log WHERE created_at >= ${since} AND char_length(q_norm) >= 2
        GROUP BY q_norm ORDER BY cnt DESC, q_norm LIMIT $1`, [lim]);
    const zero = await pool.query(
      `SELECT q_norm AS q, count(*)::int AS cnt
         FROM search_log
        WHERE created_at >= ${since} AND hits = 0 AND char_length(q_norm) >= 3
          AND q_norm NOT IN (SELECT q_norm FROM search_dismissed)
        GROUP BY q_norm HAVING count(*) >= $1
        ORDER BY cnt DESC, q_norm LIMIT $2`, [min, lim]);
    // скільки нулів приховано фільтром (разові/короткі/опрацьовані) — для контексту
    const hidden = await pool.query(
      `SELECT count(*)::int AS n FROM (
         SELECT q_norm FROM search_log
          WHERE created_at >= ${since} AND hits = 0
          GROUP BY q_norm
       ) t
       WHERE t.q_norm NOT IN (
         SELECT q_norm FROM search_log
          WHERE created_at >= ${since} AND hits = 0 AND char_length(q_norm) >= 3
            AND q_norm NOT IN (SELECT q_norm FROM search_dismissed)
          GROUP BY q_norm HAVING count(*) >= ${min}
       )`);
    res.json({
      days, min, total, zeroCnt, zeroRate, clicks: clicksRow.rows[0].n,
      top: top.rows, zero: zero.rows, noClick: noClick.rows, hiddenZero: hidden.rows[0].n
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

// POST /api/search-dismiss { q }  — позначити запит «опрацьовано» (сховати зі звіту).
app.post('/api/search-dismiss', async (req, res) => {
  if (!hasManagerKey(req)) return res.status(401).json({ error: 'unauthorized' });
  const q = String((req.body && req.body.q) || '').trim().toLowerCase().slice(0, 120);
  if (!q) return res.status(400).json({ error: 'q_required' });
  try {
    await pool.query('INSERT INTO search_dismissed (q_norm) VALUES ($1) ON CONFLICT DO NOTHING', [q]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

// === Один файл коду блоку (щоб у товарах був лише крихітний рядок) ===
// Товар містить: <div class="lartek-compat-mount"></div><script src=".../widget.js" defer></script>
// Майбутні зміни вигляду — правимо compat-widget.html, і оновлюється на всіх товарах без імпорту.
let _widgetBody = null;
function widgetBody() {
  if (_widgetBody) return _widgetBody;
  const html = fs.readFileSync(path.join(__dirname, 'embed', 'compat-widget.html'), 'utf8');
  const m = html.match(/<script>([\s\S]*)<\/script>/);
  const full = m[1];
  const marker = "root.dataset.lcInit = '1';";
  const bi = full.indexOf(marker) + marker.length;
  const ei = full.lastIndexOf('})();');
  let body = full.slice(bi, ei).replace("(root.getAttribute('data-api')||'')", "(root.getAttribute('data-api')||API_DEFAULT)");
  _widgetBody = body;
  return body;
}
app.get('/widget.js', (req, res) => {
  try {
    const origin = (req.get('x-forwarded-proto') || req.protocol) + '://' + req.get('host');
    const js = '(function(){var API_DEFAULT=' + JSON.stringify(origin) + ';'
      + 'function run(root){root.dataset.lcInit=\'1\';' + widgetBody() + '}'
      + 'function norm2(s){return String(s||\'\').toLowerCase().replace(/\\s+/g,\' \').trim();}'
      + 'var TT=[\'сумісні моделі\',\'совместимые модели\',\'совместимость с моделями\',\'сумісність з моделями\'];'
      + 'function findPanel(){var tabs=document.querySelectorAll(\'.product-heading__tab, [class*="heading__tab"]\');'
      + 'for(var i=0;i<tabs.length;i++){var tt=norm2(tabs[i].textContent);'
      + 'if(TT.indexOf(tt)>=0){var id=(tabs[i].getAttribute(\'href\')||\'\').replace(/^#/,\'\');'
      + 'if(id){var b=document.querySelector(\'[data-content-id="\'+id+\'"]\')||document.getElementById(id);if(b)return b;}}}'
      + 'var bl=document.querySelectorAll(\'[data-content-id], .j-product-block__tab, .product__section\');'
      + 'for(var j=0;j<bl.length;j++){var tx=norm2(bl[j].textContent).slice(0,80);if(/сум[іи]сн|совмест/.test(tx)&&/модел/.test(tx))return bl[j];}'
      + 'return null;}'
      // boot: якщо в описі є mount — монтуємо його (наявні товари); якщо ні — глобально
      // знаходимо вкладку «Сумісні моделі», створюємо mount і запускаємо (нові товари).
      + 'function metaSku(){var m=document.querySelector(\'meta[itemprop="sku"]\');return m?String(m.getAttribute(\'content\')||\'\').trim():\'\';}'
      // Власний блок «Сумісні моделі» — коли рідної вкладки нема (нові товари).
      + 'function makeBlock(){var isRu=/^\\/ru(\\/|$)/.test(location.pathname);'
      + 'var sec=document.createElement(\'section\');sec.className=\'lartek-compat-block\';'
      + 'sec.setAttribute(\'style\',\'margin:22px 0;padding:16px 0;border-top:1px solid #e6e9ee\');'
      + 'var h=document.createElement(\'h2\');h.setAttribute(\'style\',\'font-size:20px;margin:0 0 12px;color:#111;font-family:Arial,sans-serif\');'
      + 'h.textContent=isRu?\'Совместимые модели\':\'Сумісні моделі\';'
      + 'var m=document.createElement(\'div\');m.className=\'lartek-compat-mount\';sec.appendChild(h);sec.appendChild(m);return sec;}'
      // Ставимо блок ПІСЛЯ всього блока вкладок (не всередині опису): спершу шукаємо
      // контейнер вкладок/акордеона; якщо не знайшли — беремо елемент опису й піднімаємось
      // до його секції-обгортки, і вставляємо після неї.
      + 'function insertBlock(sec){'
      + 'var W=[\'.product-tabs\',\'.product__tabs\',\'.j-product__tabs\',\'.accordion-tabs\',\'.product-heading\',\'.j-product-tabs\'];'
      + 'for(var i=0;i<W.length;i++){var w=document.querySelector(W[i]);'
      + 'if(w&&w.parentNode){var top=w;var p=w.parentNode;'
      + 'while(p&&p!==document.body&&/^(DIV|SECTION)$/.test(p.tagName)&&p.className&&/tabs|accordion/i.test(p.className)){top=p;p=p.parentNode;}'
      + 'top.parentNode.insertBefore(sec,top.nextSibling);return true;}}'
      + 'var D=[\'#tab-description\',\'.product-description\',\'[itemprop="description"]\',\'.product__content\'];'
      + 'for(var j=0;j<D.length;j++){var el=document.querySelector(D[j]);'
      + 'if(el){var sect=el.closest(\'section, .product__section, [data-content-id]\')||el;'
      + 'if(sect.parentNode){sect.parentNode.insertBefore(sec,sect.nextSibling);return true;}}}'
      + 'return false;}'
      + 'function boot(){if(window.__lcBooted)return;'                       // захист від подвійного завантаження widget.js
      + 'var ms=document.querySelectorAll(\'.lartek-compat-mount\');'
      + 'if(ms.length){window.__lcBooted=1;for(var i=0;i<ms.length;i++){if(!ms[i].dataset.lcInit)run(ms[i]);}return;}'
      + 'var panel=findPanel();if(panel&&!panel.getAttribute(\'data-lc-done\')){window.__lcBooted=1;panel.setAttribute(\'data-lc-done\',\'1\');'
      + 'var m=document.createElement(\'div\');m.className=\'lartek-compat-mount\';panel.innerHTML=\'\';panel.appendChild(m);run(m);return;}'
      // немає вкладки — власний блок, але лише якщо в базі реально є моделі для цього артикулу
      + 'var sku=metaSku();if(!sku)return;'
      + 'fetch(API_DEFAULT+\'/api/brands?sku=\'+encodeURIComponent(sku)).then(function(r){return r.json();}).then(function(d){'
      + 'if(window.__lcBooted||!d||!d.total)return;var sec=makeBlock();if(insertBlock(sec)){window.__lcBooted=1;run(sec.querySelector(\'.lartek-compat-mount\'));}}).catch(function(){});}'
      + 'if(document.readyState===\'loading\')document.addEventListener(\'DOMContentLoaded\',boot);else boot();})();';
    res.set('Content-Type', 'application/javascript; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=300');
    res.set('Access-Control-Allow-Origin', '*');
    res.send(js);
  } catch (e) {
    console.error(e);
    res.status(500).send('// widget error');
  }
});

// === Повноекранний пошук (mss2) одним файлом — щоб у Horoshop був лише крихітний рядок ===
// У Horoshop: <script src=".../mss2.js" defer></script>. CSS вбудовується самим скриптом,
// тож сторінки легшають (~55КБ прибрано з кожної) і файл кешується браузером.
let _mss2 = null;
function mss2Body() {
  if (_mss2) return _mss2;
  const html = fs.readFileSync(path.join(__dirname, 'embed', 'mss2-search.html'), 'utf8');
  const css = (html.match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1];
  const js = (html.match(/<script>([\s\S]*?)<\/script>/) || [, ''])[1];
  _mss2 = '(function(){var st=document.createElement("style");st.textContent='
    + JSON.stringify(css) + ';document.head.appendChild(st);})();\n' + js;
  return _mss2;
}
app.get('/mss2.js', (req, res) => {
  try {
    res.set('Content-Type', 'application/javascript; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=300');
    res.set('Access-Control-Allow-Origin', '*');
    // Підставляємо адресу логування пошуку (цей самий сервер) — вмикає аналітику.
    const origin = (req.get('x-forwarded-proto') || req.protocol) + '://' + req.get('host');
    res.send(mss2Body().replace("var LOG_URL=''", 'var LOG_URL=' + JSON.stringify(origin + '/api/search-log')));
  } catch (e) {
    console.error(e);
    res.status(500).send('// mss2 error');
  }
});

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
    // пошук збігається за моделлю АБО за індустріальним кодом
    if (q.length >= MIN_CHARS) { params.push(q); where += ` AND (model_norm LIKE '%' || $${params.length} || '%' OR code_norm LIKE '%' || $${params.length} || '%')`; }

    // Перегляд бренду без запиту → посторінково (довантаження при прокрутці),
    // але сервер віддає максимум BROWSE_RATIO (60%) списку бренду — решту
    // неможливо витягти навіть технічно, лише через пошук.
    const isBrowse = hasBrand && q.length < MIN_CHARS;
    if (isBrowse) {
      const cnt = await pool.query(
        `SELECT COUNT(*)::int AS n FROM compatibility WHERE ${where}`, params
      );
      const total = cnt.rows[0].n;
      const cap = Math.min(Math.ceil(total * BROWSE_RATIO), BROWSE_MAX);
      let offset = parseInt(req.query.offset || '0', 10);
      if (!(offset >= 0)) offset = 0;
      res.set('Cache-Control', 'public, max-age=300');   // повторні перегляди — з кешу, без бази
      if (offset >= cap) return res.json({ items: [], total, cap, offset });
      const limit = Math.min(BROWSE_PAGE, cap - offset);
      const { rows } = await pool.query(
        `SELECT brand, model, code FROM compatibility WHERE ${where} ORDER BY model LIMIT ${limit} OFFSET ${offset}`,
        params
      );
      return res.json({ items: rows, total, cap, offset });
    }

    // Пошук: беремо на 1 більше за стелю, щоб зрозуміти, чи збігів забагато.
    params.push(RESULT_CAP + 1);
    const { rows } = await pool.query(
      `SELECT brand, model, code FROM compatibility WHERE ${where} ORDER BY model LIMIT $${params.length}`,
      params
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
  if (!hasManagerKey(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const sku = String(req.body.sku || '').trim();
  const models = Array.isArray(req.body.models) ? req.body.models : null;
  const replace = req.body.replace === true;
  if (!sku || !models) return res.status(400).json({ error: 'sku_and_models_required' });

  const rows = [];
  for (const m of models) {
    const model = String(m.model || '').trim();
    const mn = norm(model);
    if (!mn) continue;                       // бренд може бути порожнім
    rows.push({ sku, brand: String(m.brand || '').trim(), model, model_norm: mn, code: String(m.code || '').trim() });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (replace) await client.query('DELETE FROM compatibility WHERE sku = $1', [sku]);
    const n = await upsertRows(client, rows);   // швидка пакетна заливка (тримає й тисячі рядків)
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

// Розбір рядків Excel-таблиці для ручного завантаження (1/2/3 колонки, заголовок,
// «Бренд Модель» в одній комірці, бренд за замовчуванням). Заливає все, що у файлі —
// без обмежень «схоже на сумісність» (файл готує людина навмисно).
const SHEET_HEADWORDS = /бренд|марка|модел|код|brand|model|індустр/i;
function parseSheet(aoa, defBrand) {
  const rows = (aoa || []).map(r => (r || []).map(c => String(c == null ? '' : c).replace(/\s+/g, ' ').trim()));
  const nonEmpty = rows.filter(r => r.some(c => c));
  if (!nonEmpty.length) return [];
  let cols = null, start = 0;
  const h = nonEmpty[0];
  if (h.some(c => SHEET_HEADWORDS.test(c))) {
    cols = h.map(c => {
      const t = c.toLowerCase();
      if (/бренд|марка|brand/.test(t)) return 'brand';
      if (/індустр|код|industrial/.test(t)) return 'code';
      if (/модел|model/.test(t)) return 'model';
      return 'x';
    });
    start = 1;
  }
  const out = [];
  for (let i = start; i < nonEmpty.length; i++) {
    const r = nonEmpty[i];
    let brand = '', model = '', code = '';
    if (cols) {
      for (let j = 0; j < r.length; j++) {
        const role = cols[j];
        if (role === 'brand' && !brand) brand = r[j];
        else if (role === 'model' && !model) model = r[j];
        else if (role === 'code' && !code) code = r[j];
      }
    } else {
      const nz = r.filter(c => c);
      if (nz.length === 1) {
        const one = nz[0];
        const m = one.match(/^([A-Za-zА-Яа-яЇІЄҐїієґ][A-Za-zА-Яа-яЇІЄҐїієґ&.\- ]*?)\s+(.*\d.*)$/);
        if (m) { brand = m[1].trim(); model = m[2].trim(); } else { model = one; }
      } else { brand = nz[0]; model = nz[1]; if (nz.length >= 3) code = nz[2]; }
    }
    if (!model) continue;
    if (SHEET_HEADWORDS.test(model) && !/\d/.test(model)) continue;   // випадковий заголовок у даних
    if (!brand) brand = defBrand;
    out.push({ brand, model, code });
  }
  return out;
}

// Прочитати завантажений файл у масив рядків (aoa), розпізнаючи формат.
// Справжній .xlsx (zip, «PK») чи старий .xls (OLE2, «D0 CF») читаємо як книгу.
// Інакше це текст (TSV/CSV): визначаємо роздільник за рядком-заголовком
// (пріоритет таб → «;» → «,») і читаємо з урахуванням лапок. Без цього SheetJS сам
// угадує роздільник і на TSV, де в колонці «Код» багато ком, помилково ділить по комі
// (тоді колонка «Модель» не знаходиться → no_models).
function readAoa(buf) {
  const isZip = buf[0] === 0x50 && buf[1] === 0x4B;   // PK…  → .xlsx
  const isOle = buf[0] === 0xD0 && buf[1] === 0xCF;   // OLE2 → старий .xls
  let wb;
  if (isZip || isOle) {
    wb = XLSX.read(buf, { type: 'buffer' });
  } else {
    const text = buf.toString('utf8').replace(/^﻿/, '');   // прибрати BOM
    const head = text.split(/\r\n|\r|\n/).find(l => l.trim()) || '';
    const tabs = (head.match(/\t/g) || []).length;
    const semis = (head.match(/;/g) || []).length;
    const FS = tabs ? '\t' : (semis ? ';' : ',');
    wb = XLSX.read(text, { type: 'string', FS });
  }
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' });
}

// === Завантаження моделей одного товару з Excel-файлу (кнопка «прикріпити файл») ===
// POST /api/import-xlsx  headers: X-Import-Key
// body: { sku, replace, defBrand, fileBase64 }  (перша сторінка книги; колонки Бренд/Модель/Код)
app.post('/api/import-xlsx', async (req, res) => {
  if (!hasManagerKey(req)) return res.status(401).json({ error: 'unauthorized' });
  const sku = String((req.body && req.body.sku) || '').trim();
  const defBrand = String((req.body && req.body.defBrand) || '').trim();
  const replace = !!(req.body && req.body.replace === true);
  const b64 = String((req.body && req.body.fileBase64) || '');
  if (!sku) return res.status(400).json({ error: 'sku_required' });
  if (!b64) return res.status(400).json({ error: 'file_required' });

  let aoa;
  try {
    aoa = readAoa(Buffer.from(b64, 'base64'));
  } catch (e) { return res.status(400).json({ error: 'bad_file' }); }

  const models = parseSheet(aoa, defBrand);
  const rows = [];
  for (const m of models) {
    const mn = norm(m.model);
    if (!mn) continue;
    rows.push({ sku, brand: m.brand || '', model: m.model, model_norm: mn, code: m.code || '' });
  }
  if (!rows.length) return res.status(400).json({ error: 'no_models' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (replace) await client.query('DELETE FROM compatibility WHERE sku = $1', [sku]);
    const n = await upsertRows(client, rows);
    await client.query('COMMIT');
    res.json({ ok: true, sku, processed: n });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  } finally {
    client.release();
  }
});

// Пакетний upsert (швидко заливає багато рядків). Дедуп за (sku, model_norm),
// щоб ON CONFLICT не спіткнувся на дублі в одному запиті. ВАЖЛИВО: коди різних
// рядків однієї моделі ОБ'ЄДНУЄМО (одна модель може мати багато індустріальних
// номерів — файл дає їх окремими рядками; не втрачаємо жоден). Коди можуть уже
// бути списком через кому/«;» — розкладаємо й збираємо унікальні.
async function upsertRows(client, rows) {
  const byKey = new Map();
  for (const r of rows) {
    const key = r.sku + '|' + r.model_norm;
    let e = byKey.get(key);
    if (!e) {
      e = { sku: r.sku, brand: r.brand, model: r.model, model_norm: r.model_norm, codes: [], seen: new Set() };
      byKey.set(key, e);
    }
    String(r.code || '').split(/[,;]/).forEach(function (c) {
      c = c.trim();
      const cn = norm(c);
      if (cn && !e.seen.has(cn)) { e.seen.add(cn); e.codes.push(c); }
    });
  }
  const uniq = Array.from(byKey.values()).map(function (e) {
    return { sku: e.sku, brand: e.brand, model: e.model, model_norm: e.model_norm, code: e.codes.join(', ') };
  });
  const BATCH = 500;
  let n = 0;
  for (let i = 0; i < uniq.length; i += BATCH) {
    const part = uniq.slice(i, i + BATCH);
    const vals = [];
    const params = [];
    part.forEach((r, k) => {
      const b = k * 6;
      vals.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6})`);
      params.push(r.sku, r.brand, r.model, r.model_norm, r.code || '', norm(r.code || ''));
    });
    await client.query(
      `INSERT INTO compatibility (sku, brand, model, model_norm, code, code_norm)
         VALUES ${vals.join(',')}
         ON CONFLICT (sku, model_norm)
         DO UPDATE SET brand = EXCLUDED.brand, model = EXCLUDED.model,
                       code = EXCLUDED.code, code_norm = EXCLUDED.code_norm`,
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

// === Наповнення з ПОВНОГО експорту (XML з HTML-таблицями): парсить 2/3 колонки + код ===
// POST /api/import-export  headers: X-Import-Key
// body: { "url":"https://.../export.xml", "replace":true }
app.post('/api/import-export', async (req, res) => {
  if (req.get('X-Import-Key') !== process.env.IMPORT_KEY) return res.status(401).json({ error: 'unauthorized' });
  const url = String((req.body && req.body.url) || process.env.EXPORT_URL || '').trim();
  const replace = !!(req.body && req.body.replace === true);
  if (!url) return res.status(400).json({ ok: false, error: 'url_required' });
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', 'Accept': 'application/xml,text/xml,*/*' }
    });
    if (!r.ok) throw new Error('експорт недоступний (HTTP ' + r.status + ')');

    const client = await pool.connect();
    let products = 0, ins = 0, buf = '', pending = [];
    try {
      await client.query('BEGIN');
      if (replace) await client.query('TRUNCATE compatibility');
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      const flush = async () => { if (pending.length) { ins += await upsertRows(client, pending); pending = []; } };
      let sawOffer = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('</offer>')) >= 0) {
          const s = buf.lastIndexOf('<offer', idx);
          const off = s >= 0 ? buf.slice(s, idx + 8) : '';
          buf = buf.slice(idx + 8);
          const vc = off.match(/<vendorCode>([\s\S]*?)<\/vendorCode>/);
          const dm = off.match(/<description>([\s\S]*?)<\/description>/);
          if (!vc || !dm) continue;
          sawOffer = true;
          const sku = vc[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim();
          if (!sku) continue;
          const desc = dm[1].replace(/<!\[CDATA\[|\]\]>/g, '');
          const ents = parseTables(desc);
          if (!ents.length) continue;
          products++;
          const seen = new Set();
          for (const e of ents) {
            const mn = norm(e.model);
            if (!mn || seen.has(mn)) continue;
            seen.add(mn);
            pending.push({ sku, brand: e.brand, model: e.model, model_norm: mn, code: e.code });
          }
          if (pending.length >= 2000) await flush();
        }
        if (buf.length > 4000000) buf = buf.slice(-2000000); // страховка від розростання
      }
      await flush();
      if (!sawOffer) throw new Error('у відповіді немає <offer> (не той URL або анти-бот)');
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    res.json({ ok: true, products, rows: ins, replace });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Сторінка адміна: наповнення бази (з фіду) + ручне додавання моделей для товару.
app.get('/admin', (_req, res) => {
  res.type('html').send(`<!doctype html><html lang="uk"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Сумісні моделі — база</title>
<style>body{font-family:Arial,sans-serif;max-width:720px;margin:32px auto;padding:0 16px;color:#1f2328}
h1{font-size:20px;margin:0 0 6px}h2{font-size:16px;margin:0 0 4px}
.card{border:1px solid #e3e6ea;border-radius:12px;padding:18px;margin:18px 0}
label{display:block;margin:12px 0 4px;font-weight:700;font-size:14px}
input[type=text],input[type=password],textarea{width:100%;box-sizing:border-box;padding:11px 12px;font-size:15px;border:1px solid #d0d7de;border-radius:8px;font-family:inherit}
textarea{min-height:160px;resize:vertical;white-space:pre;overflow:auto}
.row{display:flex;align-items:center;gap:8px;margin-top:12px;font-size:14px}
button{margin-top:16px;background:#1f883d;color:#fff;border:0;border-radius:8px;padding:11px 18px;font-size:15px;font-weight:700;cursor:pointer}
button:disabled{opacity:.6;cursor:default}.hint{color:#6b7280;font-size:13px;margin-top:4px}
.out{margin-top:14px;padding:11px;border-radius:8px;white-space:pre-wrap;font-size:14px;display:none}
.ok{background:#eaf6ec;border:1px solid #bfe3c6;color:#1a7f37}.bad{background:#fdecea;border:1px solid #f3c1bb;color:#b42318}
.danger-card{border-left:4px solid #d1242f}
select{margin-top:4px;padding:10px 12px;font-size:15px;border:1px solid #d0d7de;border-radius:8px;font-family:inherit}
.saout{margin-top:14px;font-size:14px}
.sasum{margin-bottom:6px;font-size:15px}.sasum b{color:#1f2328}
.sacols{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:8px}
@media(max-width:640px){.sacols{grid-template-columns:1fr}}
.satab{width:100%;border-collapse:collapse;margin-top:6px;font-size:13px}
.satab th,.satab td{border-bottom:1px solid #eef1f4;padding:5px 6px;text-align:left;vertical-align:top}
.satab th{color:#8a929d;font-weight:700}
.satab td:nth-child(2),.satab th:nth-child(2){text-align:right;white-space:nowrap}</style>
</head><body>
<h1>Сумісні моделі — база</h1>
<p class="hint">Ключ — значення <b>IMPORT_KEY</b> зі змінних сервісу в Railway. Він нікуди не зберігається.
Ключ менеджера (<b>MANAGER_KEY</b>) працює лише для розділів 1 і 1б — масові операції (0 і 2) під ним недоступні.</p>
<label>Ключ (IMPORT_KEY)</label>
<input id="key" type="password" autocomplete="off" placeholder="встав ключ">
<div class="row"><input id="keyRemember" type="checkbox"><label style="margin:0;font-weight:400">Запам'ятати ключ у цьому браузері</label></div>

<div class="card danger-card" id="cardExp" style="display:none">
  <h2>0) Наповнити з повного експорту (рекомендовано)</h2>
  <p class="hint">Бере списки з HTML-таблиць у описах: 2 і 3 колонки, «Марка», дужки, індустріальний код.
  Встав URL повного XML-експорту товарів (з описами). «Замінити все» — повна перезаливка бази.</p>
  <label>URL повного експорту (XML)</label>
  <input id="expUrl" type="text" placeholder="https://lartek.com.ua/content/export/....xml">
  <div class="row"><input id="expReplace" type="checkbox" checked><label style="margin:0;font-weight:400">Замінити все (повна перезаливка)</label></div>
  <button id="expGo">Залити з експорту</button>
  <div class="out" id="expOut"></div>
</div>

<div class="card">
  <h2>1) Ручне додавання моделей для товару</h2>
  <p class="hint">Для нового товару: впиши артикул і встав моделі у будь-якому форматі —
  стовпчиком, через кому або «;». Розпізнається автоматично, дублікати прибираються.
  Якщо всі моделі одного бренду — впиши його у «Бренд за замовчуванням». Пробіл лишається
  частиною коду (напр. «WISL 105»). Без дефолтного бренду працює «Бренд Модель» в рядку.</p>
  <label>Артикул товару</label>
  <input id="mSku" type="text" placeholder="напр. 237">
  <label>Бренд за замовчуванням (необов'язково)</label>
  <input id="mBrand" type="text" placeholder="напр. Philips — якщо в рядках лише коди">
  <label>Моделі (стовпчиком, через кому або «;»)</label>
  <textarea id="mText" placeholder="HQ8142, HQ8150, HQ8160
S1070/04
WISL 105"></textarea>
  <div class="row"><input id="mReplace" type="checkbox" checked><label style="margin:0;font-weight:400">Замінити наявні моделі цього товару</label></div>
  <button id="mGo">Зберегти моделі</button>
  <div class="out" id="mOut"></div>
</div>

<div class="card">
  <h2>1б) Прикріпити файл з моделями</h2>
  <p class="hint">Для нового товару: впиши артикул і прикріпи файл. Приймаються .xlsx, .xls, .csv
  та текст із табуляцією / «;» / комою — формат розпізнається сам. Колонки — за
  заголовком (Бренд / Модель / Індустріальний код). Без заголовка: 1 колонка = моделі
  (бренд візьметься за замовчуванням), 2 = Бренд+Модель, 3 = Бренд+Модель+Код.</p>
  <label>Артикул товару</label>
  <input id="xSku" type="text" placeholder="напр. 237">
  <label>Бренд за замовчуванням (необов'язково)</label>
  <input id="xBrand" type="text" placeholder="напр. Philips — якщо у файлі лише коди">
  <label>Файл з моделями (.xlsx, .csv або текст)</label>
  <input id="xFile" type="file" accept=".xlsx,.xls,.csv,.txt,.tsv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,text/plain">
  <div class="row"><input id="xReplace" type="checkbox" checked><label style="margin:0;font-weight:400">Замінити наявні моделі цього товару</label></div>
  <button id="xGo">Залити з файлу</button>
  <div class="out" id="xOut"></div>
</div>

<div class="card">
  <h2>Службове: артикули в базі</h2>
  <p class="hint">Завантажити список УСІХ артикулів, що вже мають моделі в базі — для звірки
  з експортом сайту (щоб знайти товари зовсім без даних про сумісність).</p>
  <button id="skuGo">Завантажити артикули (.txt)</button>
  <div class="out" id="skuOut"></div>
</div>

<div class="card">
  <h2>Аналітика пошуку</h2>
  <p class="hint">Що люди шукають на сайті. «Без результатів» — прямий сигнал попиту:
  шукали, а не знайшли (нема товару або названо інакше).</p>
  <div class="row" style="gap:16px;flex-wrap:wrap;margin-top:0">
    <span><label>Період</label>
    <select id="saDays"><option value="7">7 днів</option><option value="30" selected>30 днів</option><option value="90">90 днів</option></select></span>
    <span><label>Мінімум повторів</label>
    <select id="saMin"><option value="1">1 (усе)</option><option value="2" selected>2</option><option value="3">3</option><option value="5">5</option></select></span>
  </div>
  <p class="hint">«Мінімум повторів» відсіює разові одруківки: 2+ = показувати лише те, що шукали кілька разів (реальний попит).</p>
  <button id="saGo">Показати</button>
  <div id="saOut"></div>
</div>

<div class="card danger-card" id="cardFeed" style="display:none">
  <h2>2) Масове наповнення з фіду Horoshop</h2>
  <p class="hint">Бере списки з описів фіду. Артикул порожній = весь сайт (~хвилина).</p>
  <label>Артикул товару (необов'язково)</label>
  <input id="sku" type="text" placeholder="напр. 0873 — порожньо = весь сайт">
  <div class="row"><input id="replace" type="checkbox"><label style="margin:0;font-weight:400">Спершу очистити старі моделі цих товарів</label></div>
  <button id="go">Імпортувати з фіду</button>
  <div class="out" id="out"></div>
</div>

<script>
function key(){return document.getElementById('key').value.trim();}
function show(el,cls,txt){el.style.display='block';el.className='out '+cls;el.textContent=txt;}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return '&#'+c.charCodeAt(0)+';';});}

// ── запам'ятовування ключа у цьому браузері (localStorage, лише за галочкою) ──
var keyEl=document.getElementById('key'),remEl=document.getElementById('keyRemember');
try{
  var savedKey=localStorage.getItem('lartekImportKey');
  if(savedKey){keyEl.value=savedKey;remEl.checked=true;}
}catch(e){}
function persistKey(){
  try{
    if(remEl.checked && key()) localStorage.setItem('lartekImportKey',key());
    else localStorage.removeItem('lartekImportKey');
  }catch(e){}
}
remEl.addEventListener('change',persistKey);
keyEl.addEventListener('input',persistKey);

// ── роль ключа: масові розділи (0 і 2) показуємо лише під головним ключем ──
var cardExp=document.getElementById('cardExp'),cardFeed=document.getElementById('cardFeed');
var roleTimer=null;
function applyRole(role){
  var full=(role==='full');
  cardExp.style.display=full?'':'none';
  cardFeed.style.display=full?'':'none';
}
function checkRole(){
  var k=key();
  if(!k){applyRole('none');return;}
  fetch('/api/keyinfo',{headers:{'X-Import-Key':k}})
    .then(function(r){return r.json();})
    .then(function(d){applyRole(d&&d.role);})
    .catch(function(){applyRole('none');});
}
keyEl.addEventListener('input',function(){clearTimeout(roleTimer);roleTimer=setTimeout(checkRole,400);});
checkRole();

// ── 0) імпорт з повного експорту ──
var expGo=document.getElementById('expGo'),expOut=document.getElementById('expOut');
expGo.onclick=function(){
  if(!key()){alert('Введи ключ');return;}
  var url=document.getElementById('expUrl').value.trim();
  if(!url){alert('Встав URL експорту');return;}
  var replace=document.getElementById('expReplace').checked;
  expGo.disabled=true; show(expOut,'','Заливаю з експорту… (кілька хвилин, не закривай сторінку)');
  fetch('/api/import-export',{method:'POST',headers:{'Content-Type':'application/json','X-Import-Key':key()},
    body:JSON.stringify({url:url,replace:replace})})
    .then(function(r){return r.json().then(function(d){return{ok:r.ok,d:d};});})
    .then(function(x){
      if(x.ok&&x.d.ok) show(expOut,'ok','Готово ✔\\nТоварів: '+x.d.products+'\\nМоделей залито: '+x.d.rows);
      else show(expOut,'bad','Помилка: '+((x.d&&x.d.error)||'невідома')+(x.d&&x.d.error==='unauthorized'?' (невірний ключ)':''));
    })
    .catch(function(e){show(expOut,'bad','Помилка з\\'єднання: '+e.message);})
    .finally(function(){expGo.disabled=false;});
};

// ── 1) ручне додавання ──
// Гнучкий розбір: моделі можна вставляти стовпчиком, через кому або «;» — усе одно
// кожна стане окремим рядком. Пробіл лишається частиною коду (напр. «WISL 105»),
// тож роздільники між моделями — лише новий рядок / кома / «;».
function parseModels(text, defBrand){
  defBrand=(defBrand||'').trim();
  var entries=String(text||'').split(/[\\r\\n,;]+/)
    .map(function(s){return s.replace(/\\s+/g,' ').trim();})
    .filter(Boolean);
  var out=[], seen={};
  entries.forEach(function(entry){
    entry=entry.replace(/^\\s*(?:\\d+[.)]\\s*|[-–—•*]\\s*)/,'').trim();   // прибрати «1.», «- », «• »
    if(!entry) return;
    var brand, model;
    if(defBrand){
      brand=defBrand; model=entry;                       // бренд заданий → весь запис = модель
    } else {
      var parts=entry.split(/\\t|\\s{2,}/).map(function(s){return s.trim();}).filter(Boolean);
      if(parts.length>=2){ brand=parts[0]; model=parts.slice(1).join(' '); }
      else {
        var m=entry.match(/^([A-Za-zА-Яа-яЇІЄҐїієґ&.\\-]{2,})\\s+(.*\\d.*)$/);
        if(m){ brand=m[1]; model=m[2]; } else { brand=''; model=entry; }
      }
    }
    model=model.trim(); if(!model) return;
    var kkey=(brand+'|'+model).toLowerCase();
    if(seen[kkey]) return; seen[kkey]=1;                  // прибрати дублікати
    out.push({brand:brand||'', model:model});
  });
  return out;
}
var mGo=document.getElementById('mGo'),mOut=document.getElementById('mOut');
mGo.onclick=function(){
  if(!key()){alert('Введи ключ');return;}
  var sku=document.getElementById('mSku').value.trim();
  var defBrand=document.getElementById('mBrand').value.trim();
  var models=parseModels(document.getElementById('mText').value, defBrand);
  var replace=document.getElementById('mReplace').checked;
  if(!sku){alert('Впиши артикул');return;}
  if(!models.length){alert('Встав хоч одну модель');return;}
  mGo.disabled=true; show(mOut,'','Зберігаю '+models.length+' рядків…');
  fetch('/api/import',{method:'POST',headers:{'Content-Type':'application/json','X-Import-Key':key()},
    body:JSON.stringify({sku:sku,models:models,replace:replace})})
    .then(function(r){return r.json().then(function(d){return{ok:r.ok,d:d};});})
    .then(function(x){
      if(x.ok&&x.d.processed!=null) show(mOut,'ok','Готово ✔ Збережено моделей: '+x.d.processed+' (артикул '+x.d.sku+')');
      else show(mOut,'bad','Помилка: '+((x.d&&x.d.error)||'невідома')+(x.d&&x.d.error==='unauthorized'?' (невірний ключ)':''));
    })
    .catch(function(e){show(mOut,'bad','Помилка з\\'єднання: '+e.message);})
    .finally(function(){mGo.disabled=false;});
};

// ── 1б) прикріплення Excel-файлу ──
var xGo=document.getElementById('xGo'),xOut=document.getElementById('xOut');
xGo.onclick=function(){
  if(!key()){alert('Введи ключ');return;}
  var sku=document.getElementById('xSku').value.trim();
  var defBrand=document.getElementById('xBrand').value.trim();
  var f=document.getElementById('xFile').files[0];
  var replace=document.getElementById('xReplace').checked;
  if(!sku){alert('Впиши артикул');return;}
  if(!f){alert('Прикріпи файл (.xlsx, .csv або текст)');return;}
  var reader=new FileReader();
  reader.onload=function(){
    var b64=String(reader.result).split(',').pop();
    xGo.disabled=true; show(xOut,'','Читаю файл і заливаю…');
    fetch('/api/import-xlsx',{method:'POST',headers:{'Content-Type':'application/json','X-Import-Key':key()},
      body:JSON.stringify({sku:sku,defBrand:defBrand,replace:replace,fileBase64:b64})})
      .then(function(r){return r.json().then(function(d){return{ok:r.ok,d:d};});})
      .then(function(x){
        if(x.ok&&x.d.ok) show(xOut,'ok','Готово ✔ Збережено моделей: '+x.d.processed+' (артикул '+x.d.sku+')');
        else show(xOut,'bad','Помилка: '+((x.d&&x.d.error)||'невідома')+(x.d&&x.d.error==='unauthorized'?' (невірний ключ)':x.d&&x.d.error==='no_models'?' (у файлі не знайдено моделей)':''));
      })
      .catch(function(e){show(xOut,'bad','Помилка з\\'єднання: '+e.message);})
      .finally(function(){xGo.disabled=false;});
  };
  reader.onerror=function(){show(xOut,'bad','Не вдалося прочитати файл');};
  reader.readAsDataURL(f);
};

// ── Службове: завантажити артикули з бази ──
var skuGo=document.getElementById('skuGo'),skuOut=document.getElementById('skuOut');
skuGo.onclick=function(){
  if(!key()){alert('Введи ключ');return;}
  skuGo.disabled=true; show(skuOut,'','Отримую список…');
  fetch('/api/skus',{headers:{'X-Import-Key':key()}})
    .then(function(r){return r.json().then(function(d){return{ok:r.ok,d:d};});})
    .then(function(x){
      if(!x.ok||!x.d.skus){show(skuOut,'bad','Помилка: '+((x.d&&x.d.error)||'невідома')+(x.d&&x.d.error==='unauthorized'?' (невірний ключ)':''));return;}
      var txt=x.d.skus.join('\\n');
      var blob=new Blob([txt],{type:'text/plain;charset=utf-8'});
      var a=document.createElement('a');
      a.href=URL.createObjectURL(blob); a.download='artikuly_v_bazi.txt';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function(){URL.revokeObjectURL(a.href);},1000);
      show(skuOut,'ok','Готово ✔ Артикулів у базі: '+x.d.count+'\\nФайл artikuly_v_bazi.txt завантажено.');
    })
    .catch(function(e){show(skuOut,'bad','Помилка з\\'єднання: '+e.message);})
    .finally(function(){skuGo.disabled=false;});
};

// ── Аналітика пошуку ──
var saGo=document.getElementById('saGo'),saOut=document.getElementById('saOut');
function saLoad(){
  if(!key()){alert('Введи ключ');return;}
  var days=document.getElementById('saDays').value, min=document.getElementById('saMin').value;
  saGo.disabled=true; saOut.className=''; saOut.style.display='block'; saOut.textContent='Рахую…';
  fetch('/api/search-stats?days='+days+'&min='+min+'&limit=50',{headers:{'X-Import-Key':key()}})
    .then(function(r){return r.json().then(function(d){return{ok:r.ok,d:d};});})
    .then(function(x){
      if(!x.ok){saOut.className='out bad';saOut.textContent='Помилка: '+((x.d&&x.d.error)||'невідома')+(x.d&&x.d.error==='unauthorized'?' (невірний ключ)':'');return;}
      var d=x.d;
      function topTbl(rows){
        if(!rows||!rows.length) return '<b>🔝 Топ запитів</b><div class="hint">— порожньо —</div>';
        var h='<b>🔝 Топ запитів</b><table class="satab"><tr><th>Запит</th><th>Разів</th><th>Макс. знайдено</th></tr>';
        rows.forEach(function(r){ h+='<tr><td>'+esc(r.q)+'</td><td>'+r.cnt+'</td><td>'+r.max_hits+'</td></tr>'; });
        return h+'</table>';
      }
      function zeroTbl(rows){
        if(!rows||!rows.length) return '<b>❌ Без результатів</b><div class="hint">— порожньо (усе опрацьовано або відсіяно) —</div>';
        var h='<b>❌ Без результатів</b><table class="satab"><tr><th>Запит</th><th>Разів</th><th></th></tr>';
        rows.forEach(function(r){ h+='<tr><td>'+esc(r.q)+'</td><td>'+r.cnt+'</td><td><button class="sadis" data-q="'+esc(r.q)+'" style="margin:0;padding:3px 8px;font-size:12px;background:#6b7280">опрацьовано</button></td></tr>'; });
        return h+'</table>';
      }
      function noClickTbl(rows){
        if(!rows||!rows.length) return '<b>🖱 Показали, але не клікнули</b><div class="hint">— порожньо —</div>';
        var h='<b>🖱 Показали, але не клікнули</b> <span class="hint">(результати були, та жодного переходу — можливо, видача нерелевантна)</span>'
          +'<table class="satab"><tr><th>Запит</th><th>Разів</th></tr>';
        rows.forEach(function(r){ h+='<tr><td>'+esc(r.q)+'</td><td>'+r.cnt+'</td></tr>'; });
        return h+'</table>';
      }
      saOut.className='saout'; saOut.style.display='block';
      saOut.innerHTML='<div class="sasum">Пошуків: <b>'+d.total+'</b> · Без результату: <b>'+d.zeroCnt+' ('+d.zeroRate+'%)</b> · Кліків: <b>'+d.clicks+'</b> <span class="hint">· приховано разових/опрацьованих нулів: '+(d.hiddenZero||0)+'</span></div>'
        +'<div class="sacols">'+topTbl(d.top)+zeroTbl(d.zero)+'</div>'
        +'<div style="margin-top:14px">'+noClickTbl(d.noClick)+'</div>';
      saOut.querySelectorAll('.sadis').forEach(function(b){ b.onclick=function(){
        b.disabled=true;
        fetch('/api/search-dismiss',{method:'POST',headers:{'Content-Type':'application/json','X-Import-Key':key()},body:JSON.stringify({q:b.getAttribute('data-q')})})
          .then(function(){ saLoad(); });
      };});
    })
    .catch(function(e){saOut.className='out bad';saOut.textContent='Помилка з\\'єднання: '+e.message;})
    .finally(function(){saGo.disabled=false;});
}
saGo.onclick=saLoad;

// ── 2) імпорт з фіду ──
var go=document.getElementById('go'),out=document.getElementById('out');
go.onclick=function(){
  if(!key()){alert('Введи ключ');return;}
  var sku=document.getElementById('sku').value.trim();
  var replace=document.getElementById('replace').checked;
  go.disabled=true; show(out,'','Імпортую… (для всього сайту — кілька хвилин, не закривай сторінку)');
  fetch('/api/import-feed',{method:'POST',headers:{'Content-Type':'application/json','X-Import-Key':key()},
    body:JSON.stringify(sku?{sku:sku,replace:replace}:{replace:replace})})
    .then(function(r){return r.json().then(function(d){return{ok:r.ok,d:d};});})
    .then(function(x){
      if(x.ok&&x.d.ok) show(out,'ok','Готово ✔\\nТоварів: '+x.d.products+'\\nМоделей залито: '+x.d.rows+'\\nОхоплення: '+x.d.scope);
      else show(out,'bad','Помилка: '+((x.d&&x.d.error)||'невідома')+(x.d&&x.d.error==='unauthorized'?' (невірний ключ)':''));
    })
    .catch(function(e){show(out,'bad','Помилка з\\'єднання: '+e.message);})
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
      ? await pool.query('SELECT sku, model, code FROM compatibility WHERE sku = $1 ORDER BY sku, model', [sku])
      : await pool.query('SELECT sku, model, code FROM compatibility ORDER BY sku, model');
    const map = new Map();
    for (const r of rows) {
      if (!map.has(r.sku)) map.set(r.sku, []);
      const arr = map.get(r.sku);
      arr.push(r.model);
      // Індустріальні коди теж у пошукове поле — щоб пошук сайту (Meili) знаходив
      // товар за кодом (напр. VCC4110S3N/XSP), а не лише за назвою моделі (SC4110).
      // Поле приховане (не показується), тож коди лишаються не видимими для копіювання.
      if (r.code) arr.push(r.code);
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
