// Пошук товару на сайті-донорі за каталожним кодом — щоб не вводити ID кожного товару руками.
//
// УВАГА: точний ендпойнт пошуку донора з'ясовується на живому сайті (крок «розвідка» в README).
// Тут перебираються типові варіанти; коли справжній відомий — впиши його в DONOR_SEARCH_PATH
// (напр. DONOR_SEARCH_PATH="/ua/api/search?q={q}") і перебір відпаде сам собою.
// {q} у шаблоні — місце для коду.
//
// Відповідь донора може бути і JSON, і HTML — обробляються обидва випадки:
//   JSON → шукаємо масив об'єктів з назвою та посиланням/ID;
//   HTML → беремо посилання, у яких код видно в адресі або в тексті.

const { norm } = require('./norm');         // та сама нормалізація, що й для моделей
const { parseHost, resolvePid } = require('./donor');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const DEFAULT_PATHS = [
  '/{lang}/search?q={q}',
  '/{lang}/api/search?q={q}',
  '/search?q={q}',
];

// Адреса пошуку донора — з його ж форми пошуку на головній сторінці.
// Кожен сайт має <form action="…"><input name="…">, тож шаблон можна не вгадувати.
// Повертає напр. '/ua/search?query={q}' або null, якщо форми не видно.
function searchPathFromHtml(html, lang) {
  const forms = String(html || '').match(/<form\b[\s\S]{0,2000}?<\/form>/gi) || [];
  const NAME = /^(q|s|query|search|keyword|keywords|text|term|searchstring)$/i;
  for (const f of forms) {
    const inputs = f.match(/<input\b[^>]*>/gi) || [];
    let field = null;
    for (const i of inputs) {
      const n = (i.match(/\bname=["']([^"']+)["']/i) || [])[1];
      if (!n) continue;
      const type = (i.match(/\btype=["']([^"']+)["']/i) || [])[1] || 'text';
      if (/^(hidden|submit|button|checkbox|radio)$/i.test(type)) continue;
      if (NAME.test(n) || /search/i.test(n)) { field = n; break; }
    }
    if (!field) continue;
    let action = (f.match(/<form\b[^>]*\baction=["']([^"']*)["']/i) || [])[1] || '';
    if (/^https?:\/\//i.test(action)) { try { action = new URL(action).pathname; } catch (e) { continue; } }
    if (!action) action = '/' + lang + '/search';
    if (!action.startsWith('/')) action = '/' + action;
    return action + (action.includes('?') ? '&' : '?') + field + '={q}';
  }
  return null;
}

async function discoverSearchPath(options) {
  const o = options || {};
  const host = parseHost(o.host);
  const lang = o.lang || 'ua';
  for (const page of ['https://' + host + '/' + lang + '/', 'https://' + host + '/']) {
    try {
      const got = await fetchAny(page, o);
      if (!got.html) continue;
      const tpl = searchPathFromHtml(got.html, lang);
      if (tpl) return tpl;
    } catch (e) { /* пробуємо наступну сторінку */ }
  }
  return null;
}

async function fetchAny(url, opts) {
  const headers = {
    'User-Agent': opts.userAgent || UA,
    'Accept': 'application/json, text/html;q=0.9, */*;q=0.8',
    'X-Requested-With': 'XMLHttpRequest',
  };
  if (opts.cookie) headers.Cookie = opts.cookie;
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(opts.timeoutMs || 25000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const text = await r.text();
  const ct = r.headers && r.headers.get ? String(r.headers.get('content-type') || '') : '';
  if (/json/i.test(ct) || /^\s*[{[]/.test(text)) {
    try { return { json: JSON.parse(text) }; } catch (e) { /* не JSON — читаємо як HTML */ }
  }
  return { html: text };
}

const strip = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;|&#\d+;/gi, ' ').replace(/\s+/g, ' ').trim();

// Товари з JSON-відповіді: масив об'єктів, у яких є назва і хоч якийсь ідентифікатор.
function itemsFromJson(x) {
  const ok = (i) => i && typeof i === 'object' && (i.name || i.title) && (i.url || i.link || i.slug || i.id);
  const deep = (v) => {
    if (Array.isArray(v)) {
      if (v.length && v.every(ok)) return v;
      for (const i of v) { const f = deep(i); if (f) return f; }
    } else if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) { const f = deep(v[k]); if (f) return f; }
    }
    return null;
  };
  return (deep(x) || []).map((i) => ({
    title: strip(i.name || i.title),
    url: i.url || i.link || i.slug || '',
    id: i.id != null ? String(i.id) : '',
    code: strip(i.industrial_code || i.code || i.sku || i.vendor_code || ''),
  }));
}

// Товари з HTML: посилання, у яких код видно в адресі або в тексті.
function itemsFromHtml(html, code) {
  const want = norm(code);
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,400}?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = m[1];
    const title = strip(m[2]);
    if (!title) continue;
    if (/^(#|javascript:|mailto:|tel:)/i.test(href)) continue;
    if (!want || (!norm(href).includes(want) && !norm(title).includes(want))) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    out.push({ title, url: href, id: '', code: '' });
    if (out.length >= 20) break;
  }
  return out;
}

const absolute = (host, url) => {
  const u = String(url || '');
  if (/^https?:\/\//i.test(u)) return u;
  return 'https://' + host + (u.startsWith('/') ? u : '/' + u);
};

// Наскільки впевнено це «той самий» товар:
//   exact — нормалізований код збігається з кодом або трапляється в назві/адресі товару;
//   weak  — товар знайшовся, але коду не видно (перевіряє людина);
// Порівнюємо цілим входженням, бо коди різних деталей відрізняються лише хвостом.
function confidenceOf(item, code, host) {
  const want = norm(code);
  if (!want) return 'weak';
  const hay = norm(item.code) + ' ' + norm(item.title) + ' ' + norm(absolute(host, item.url));
  return hay.includes(want) ? 'exact' : 'weak';
}

// Пошук за одним кодом. Повертає { path, items } — items уже з абсолютними посиланнями.
async function searchDonor(options) {
  const o = options || {};
  const host = parseHost(o.host);
  const code = String(o.code || '').trim();
  if (!code) throw new Error('code_required');
  const lang = o.lang || 'ua';
  let paths = (o.searchPath ? [o.searchPath] : (process.env.DONOR_SEARCH_PATH ? [process.env.DONOR_SEARCH_PATH] : null));
  if (!paths) {
    // Шаблон не заданий — спершу питаємо в самого сайту (його форма пошуку),
    // і лише потім перебираємо типові варіанти.
    const found = await discoverSearchPath(o);
    paths = found ? [found].concat(DEFAULT_PATHS.filter((p) => p !== found)) : DEFAULT_PATHS;
  }

  let lastErr = null;
  for (const tpl of paths) {
    const url = 'https://' + host + tpl.replace('{lang}', lang).replace('{q}', encodeURIComponent(code));
    let got;
    try { got = await fetchAny(url, o); } catch (e) { lastErr = e; continue; }
    const items = (got.json ? itemsFromJson(got.json) : itemsFromHtml(got.html, code))
      .map((i) => Object.assign({}, i, {
        url: absolute(host, i.url),
        confidence: confidenceOf(i, code, host),
      }));
    if (items.length) {
      items.sort((a, b) => (a.confidence === 'exact' ? -1 : 1) - (b.confidence === 'exact' ? -1 : 1));
      return { path: tpl, items };
    }
  }
  if (lastErr) throw lastErr;
  return { path: null, items: [] };
}

// Знайти товар за списком кандидатів коду й довести його до pid.
// Зупиняємось на першому ж точному збігу; слабкі збіги повертаємо як є — рішення за людиною.
async function matchDonorProduct(options) {
  const o = options || {};
  const codes = (Array.isArray(o.codes) ? o.codes : [o.code]).filter(Boolean);
  if (!codes.length) return { confidence: 'none', reason: 'no_code' };

  let weak = null;
  for (const code of codes) {
    let found;
    try { found = await searchDonor(Object.assign({}, o, { code })); }
    catch (e) { return { confidence: 'none', reason: e.message, code }; }
    for (const item of found.items) {
      if (item.confidence !== 'exact') { if (!weak) weak = Object.assign({ code }, item); continue; }
      try {
        // ID зі списку пошуку не обов'язково той самий, що в API сумісності,
        // тому pid беремо зі сторінки товару; id — лише запасний варіант.
        const pid = await resolvePid(item.url || item.id, o);
        return Object.assign({}, item, { code, pid, confidence: 'exact' });
      } catch (e) { if (!weak) weak = Object.assign({ code, reason: e.message }, item); }
    }
    if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
  }
  if (weak) {
    try { weak.pid = await resolvePid(weak.url || weak.id, o); } catch (e) { weak.reason = e.message; }
    return Object.assign(weak, { confidence: 'weak' });
  }
  return { confidence: 'none', reason: 'not_found', code: codes[0] };
}

module.exports = {
  searchDonor, matchDonorProduct, itemsFromJson, itemsFromHtml, confidenceOf,
  discoverSearchPath, searchPathFromHtml, DEFAULT_PATHS,
};
