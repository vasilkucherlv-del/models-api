// Збір списку сумісних моделей зі стороннього сайту-донора.
//
// Повторює те саме, що робить закладка (bookmarklet) у браузері, але без браузера:
//   GET https://<host>/<lang>/api/models/compatibility/<pid>              → список брендів
//   GET https://<host>/<lang>/api/models/compatibility/<pid>?brand_id=N   → моделі бренду
// Далі моделі всіх брендів зводяться в один список {brand, model, code}.
//
// Модуль без залежностей і без БД — його використовують і CLI (import-donor.js),
// і сервер (POST /api/import-donor).

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const DEFAULTS = {
  lang: 'ua',
  delayMs: 1000,        // пауза між брендами (щоб не довбати донора)
  retries: 5,           // спроб на бренд
  retryDelayMs: 4000,   // пауза перед повтором
  timeoutMs: 25000,     // таймаут одного запиту
  maxModels: 50000,     // запобіжник від нескінченної відповіді
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Хост донора: приймає і «servicemarket.com.ua», і повний URL сторінки товару.
// Локальні/приватні адреси відхиляємо — ендпойнт сервера не має ходити всередину мережі.
function parseHost(input) {
  let h = String(input || '').trim();
  if (!h) throw new Error('host_required');
  if (/^https?:\/\//i.test(h)) {
    try { h = new URL(h).hostname; } catch (e) { throw new Error('bad_host'); }
  }
  h = h.replace(/^\/+|\/+$/g, '').split('/')[0].split('@').pop();
  if (!/^[a-z0-9.-]+$/i.test(h) || !h.includes('.')) throw new Error('bad_host');
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(h)) throw new Error('bad_host');
  if (/\.(local|internal|localdomain)$/i.test(h)) throw new Error('bad_host');
  return h.toLowerCase();
}

async function getJson(url, opts) {
  const headers = {
    'User-Agent': opts.userAgent || UA,
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'X-Requested-With': 'XMLHttpRequest',
  };
  if (opts.cookie) headers.Cookie = opts.cookie;
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(opts.timeoutMs || DEFAULTS.timeoutMs) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return await r.json();
}

async function getText(url, opts) {
  const headers = {
    'User-Agent': opts.userAgent || UA,
    'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
  };
  if (opts.cookie) headers.Cookie = opts.cookie;
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(opts.timeoutMs || DEFAULTS.timeoutMs) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return await r.text();
}

// Донор може загорнути дані в різні обгортки, тож шукаємо потрібний масив у глибину —
// так само, як закладка: бренди = об'єкти з id + name + count.
function findBrands(x) {
  if (Array.isArray(x)) {
    if (x.length && x.every((i) => i && typeof i === 'object' && 'id' in i && 'name' in i && 'count' in i)) return x;
    for (const i of x) { const f = findBrands(i); if (f) return f; }
  } else if (x && typeof x === 'object') {
    for (const k of Object.keys(x)) { const f = findBrands(x[k]); if (f) return f; }
  }
  return null;
}

// Моделі: штатно лежать у data.models; якщо структура інша — шукаємо масив об'єктів,
// у яких є name і хоча б одне з полів бренду/індустріального коду.
function findModels(x) {
  const direct = x && x.data && Array.isArray(x.data.models) ? x.data.models : null;
  if (direct) return direct;
  const deep = (v) => {
    if (Array.isArray(v)) {
      if (v.length && v.every((i) => i && typeof i === 'object' && 'name' in i &&
          ('industrial_code' in i || 'brand_name' in i))) return v;
      for (const i of v) { const f = deep(i); if (f) return f; }
    } else if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) { const f = deep(v[k]); if (f) return f; }
    }
    return null;
  };
  return deep(x) || [];
}

const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

// ID товару на донорі. Приймає число, повний URL сторінки товару або URL API.
// Для сторінки товару — тягне HTML і шукає в ньому «compatibility/<id>»
// (той самий слід, який закладка знаходила серед мережевих запитів).
async function resolvePid(input, opts) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('pid_required');
  if (/^\d+$/.test(raw)) return raw;

  const m = raw.match(/compatibility\/(\d+)/);
  if (m) return m[1];

  if (!/^https?:\/\//i.test(raw)) throw new Error('bad_pid');
  const o = opts || {};
  const html = await getText(raw, o);
  const hit = html.match(/compatibility\/(\d+)/);
  if (hit) return hit[1];

  // Сліду «compatibility/<ID>» у HTML немає — отже блок сумісності підвантажується
  // скриптом. Тоді збираємо з коду сторінки всі числа, схожі на ID товару, і просто
  // ПЕРЕВІРЯЄМО кожен на API сумісності: правильний віддасть список брендів.
  // Так ID не треба діставати руками з DevTools чи з імені файлу закладки.
  const host = parseHost(new URL(raw).hostname);
  const lang = o.lang || DEFAULTS.lang;
  const tried = [];
  for (const id of idCandidates(html, raw)) {
    if (tried.length >= (o.maxIdTries || 8)) break;
    tried.push(id);
    try {
      const data = await getJson(`https://${host}/${lang}/api/models/compatibility/${id}`, o);
      const brands = findBrands(data);
      if (brands && brands.length) return id;
    } catch (e) { /* не той ID — пробуємо наступний */ }
    await sleep(o.delayMs != null ? o.delayMs : DEFAULTS.delayMs);
  }
  const err = new Error('pid_not_found');
  err.tried = tried;
  throw err;
}

// Числа зі сторінки, схожі на ID товару, від найімовірнішого до найменш імовірного.
// Беремо з типових місць (data-атрибути, JSON у скриптах, посилання на кошик/обране),
// відсіюючи роки, ціни й інші випадкові числа.
function idCandidates(html, pageUrl) {
  const out = [];
  const seen = new Set();
  const add = (v) => {
    const s = String(v || '').replace(/^0+(?=\d)/, '');
    if (!/^\d{1,9}$/.test(s)) return;
    const n = parseInt(s, 10);
    if (n <= 0) return;
    if (seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  const grab = (re) => { let m; while ((m = re.exec(html))) add(m[1]); };

  // Порядок важливий: спершу те, що прямо називає себе ID товару, і лише потім
  // загальні «id» — інакше в перших спробах опиниться ID категорії чи банера.
  grab(/data-product[-_]?id=["'](\d+)["']/gi);
  grab(/["'](?:product_id|productId|item_id|itemId|offer_id)["']\s*:\s*["']?(\d+)/gi);
  grab(/\/(?:cart|basket|wishlist|favorite[s]?|compare)\/(?:add\/)?(\d+)/gi);
  grab(/name=["']product(?:_id)?["'][^>]*value=["'](\d+)["']/gi);
  grab(/value=["'](\d+)["'][^>]*name=["']product(?:_id)?["']/gi);
  grab(/["'](?:productID|sku)["']\s*:\s*["'](\d+)["']/gi);      // JSON-LD
  grab(/data-id=["'](\d+)["']/gi);
  grab(/["']id["']\s*:\s*(\d+)/gi);
  if (pageUrl) { const m = String(pageUrl).match(/\/(\d+)(?:\/|$|\?)/); if (m) add(m[1]); }
  return out;
}

// Головна функція: обходить усі бренди товару й повертає зведений список моделей.
// onProgress({ done, total, brand, models }) — для показу прогресу.
async function collectDonorModels(options) {
  const o = Object.assign({}, DEFAULTS, options || {});
  const host = parseHost(o.host);
  const onProgress = o.onProgress || (() => {});
  const deadline = o.timeBudgetMs ? Date.now() + o.timeBudgetMs : Infinity;

  const pid = await resolvePid(o.pid || o.url, o);
  const base = `https://${host}/${o.lang}/api/models/compatibility/${pid}`;

  const brands = findBrands(await getJson(base, o));
  if (!brands || !brands.length) throw new Error('no_brands');

  const seen = new Set();
  const models = [];
  let stopped = false;
  const failed = [];

  for (let i = 0; i < brands.length; i++) {
    if (Date.now() > deadline) { stopped = true; break; }
    const b = brands[i];
    let ok = false;
    for (let a = 1; a <= o.retries && !ok; a++) {
      try {
        const data = await getJson(base + '?brand_id=' + encodeURIComponent(b.id), o);
        for (const m of findModels(data)) {
          const row = {
            brand: clean(m.brand_name || b.name),
            model: clean(m.name),
            code: clean(m.industrial_code),
          };
          if (!row.model) continue;
          const key = (row.brand + '|' + row.model + '|' + row.code).toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          models.push(row);
          if (models.length >= o.maxModels) { stopped = true; break; }
        }
        ok = true;
      } catch (e) {
        if (a >= o.retries) { failed.push(clean(b.name) || String(b.id)); break; }
        await sleep(o.retryDelayMs);
      }
    }
    onProgress({ done: i + 1, total: brands.length, brand: clean(b.name), models: models.length });
    if (stopped) break;
    if (i < brands.length - 1) await sleep(o.delayMs);
  }

  return { host, pid, brands: brands.length, models, failed, stopped };
}

module.exports = { collectDonorModels, resolvePid, idCandidates, parseHost, findBrands, findModels, DEFAULTS };
