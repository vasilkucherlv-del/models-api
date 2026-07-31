// Діагностика зв'язку з сайтом-донором: одна перевірка, яка відповідає «що саме пішло не так».
//
// Потрібна тому, що структура API донора з'ясовується вже на живому сайті. Без неї збій виглядає
// як сухе «no_brands», і причина невідома: потрібен логін? інша структура відповіді? бан за
// частоту? не той шлях пошуку? Ця перевірка проходить увесь ланцюг по одному кроку й показує,
// що донор віддав насправді — разом з уривком відповіді, за яким можна полагодити розбір.
//
// Нічого не пише в базу і не обходить усі бренди: один товар, один бренд, кілька шаблонів пошуку.

const { parseHost, resolvePid, findBrands, findModels } = require('./donor');
const { DEFAULT_PATHS, itemsFromJson, itemsFromHtml } = require('./donor-search');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const SNIPPET = 600;

// Ознаки сторінки входу — коли донор замість даних віддає форму логіну.
const LOGIN_HINTS = /(<form[^>]+(login|signin|auth))|name=["']password["']|\b(увійти|вхід у кабінет|авторизац|sign in|log in)\b/i;

// Уривок відповіді у вигляді, придатному для читання людиною: без скриптів, стилів і тегів.
function snippet(text) {
  return String(text || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SNIPPET);
}

// Один запит із повним звітом: що відповіли, чи це JSON, як виглядає тіло.
async function probeFetch(url, o) {
  const headers = {
    'User-Agent': o.userAgent || UA,
    'Accept': 'application/json, text/html;q=0.9, */*;q=0.8',
    'X-Requested-With': 'XMLHttpRequest',
  };
  if (o.cookie) headers.Cookie = o.cookie;
  const out = { url, status: 0, ok: false, contentType: '', isJson: false, json: null, text: '', snippet: '' };
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(o.timeoutMs || 25000) });
    out.status = r.status;
    out.ok = r.ok;
    out.contentType = (r.headers && r.headers.get ? String(r.headers.get('content-type') || '') : '');
    out.text = await r.text();
    if (/json/i.test(out.contentType) || /^\s*[{[]/.test(out.text)) {
      try { out.json = JSON.parse(out.text); out.isJson = true; } catch (e) { /* не JSON */ }
    }
    out.snippet = snippet(out.text);
  } catch (e) {
    out.error = e.message || String(e);
  }
  return out;
}

// Що сказати людині про конкретну відповідь донора.
function readResponse(res) {
  if (res.error) return { bad: true, why: 'мережа: ' + res.error };
  if (res.status === 401 || res.status === 403) return { bad: true, why: 'донор відмовив (HTTP ' + res.status + ') — найімовірніше потрібна кука сесії', needCookie: true };
  if (res.status === 429) return { bad: true, why: 'донор обмежує частоту (HTTP 429)', rateLimited: true };
  if (res.status >= 500) return { bad: true, why: 'помилка на боці донора (HTTP ' + res.status + ')' };
  if (!res.ok) return { bad: true, why: 'HTTP ' + res.status };
  if (!res.isJson && LOGIN_HINTS.test(res.text)) return { bad: true, why: 'замість даних віддано сторінку входу — потрібна кука сесії', needCookie: true };
  return { bad: false };
}

// Головна перевірка. Кроки йдуть по черзі; якщо крок провалився — наступні, що від нього
// залежать, не виконуються (щоб не сипати похідними помилками).
async function probeDonor(options) {
  const o = options || {};
  const host = parseHost(o.host);
  const lang = o.lang || 'ua';
  const steps = [];
  const verdict = [];
  let needCookie = false, rateLimited = false;

  // Крок 1 — сторінка товару: чи можна взяти з неї ID для API сумісності.
  let pid = String(o.pid || '').trim();
  const page = String(o.url || (/^https?:\/\//i.test(pid) ? pid : '')).trim();
  if (!pid || !/^\d+$/.test(pid)) {
    if (!page) throw new Error('pid_or_url_required');
    const res = await probeFetch(page, o);
    const read = readResponse(res);
    const hit = res.text.match(/compatibility\/(\d+)/);
    if (hit) pid = hit[1];
    steps.push({
      step: 'page', title: 'Сторінка товару', url: page, status: res.status,
      contentType: res.contentType, ok: !!hit && !read.bad,
      found: hit ? ('ID товару: ' + hit[1]) : 'ID у HTML не знайдено',
      snippet: hit ? '' : res.snippet, error: res.error || '',
    });
    if (read.needCookie) needCookie = true;
    if (read.rateLimited) rateLimited = true;
    if (!hit) {
      verdict.push(read.bad
        ? '✖ Сторінка товару не віддалась: ' + read.why
        : '✖ На сторінці товару немає «compatibility/<ID>» — або це не сторінка товару, або ID вантажиться інакше. Візьми ID із DevTools (вкладка Network, запит до /api/models/compatibility/…) і встав його замість посилання.');
      return { host, pid: '', steps, verdict, needCookie, rateLimited };
    }
  }

  const base = 'https://' + host + '/' + lang + '/api/models/compatibility/' + pid;

  // Крок 2 — список брендів товару (з нього починається і сам збір).
  const bRes = await probeFetch(base, o);
  const bRead = readResponse(bRes);
  const brands = bRes.isJson ? findBrands(bRes.json) : null;
  if (bRead.needCookie) needCookie = true;
  if (bRead.rateLimited) rateLimited = true;
  steps.push({
    step: 'brands', title: 'Список брендів', url: base, status: bRes.status,
    contentType: bRes.contentType, ok: !!(brands && brands.length),
    found: brands && brands.length ? ('брендів: ' + brands.length + ' — ' + brands.slice(0, 5).map((b) => b.name).join(', ')) : 'брендів не розпізнано',
    snippet: brands && brands.length ? '' : bRes.snippet, error: bRes.error || '',
  });

  if (!brands || !brands.length) {
    if (bRead.bad) verdict.push('✖ Бренди не отримано: ' + bRead.why);
    else if (bRes.isJson) verdict.push('✖ Донор віддав JSON, але список брендів у ньому не розпізнався — структура відповіді інша, ніж очікує розбір. Надішли мені уривок нижче, і я його полагоджу.');
    else verdict.push('✖ Донор віддав не JSON (' + (bRes.contentType || 'тип невідомий') + '). Перевір, чи правильний ID товару.');
  } else {
    // Крок 3 — моделі першого бренду: перевірка, що дані реально приходять.
    const mUrl = base + '?brand_id=' + encodeURIComponent(brands[0].id);
    const mRes = await probeFetch(mUrl, o);
    const mRead = readResponse(mRes);
    const models = mRes.isJson ? findModels(mRes.json) : [];
    if (mRead.needCookie) needCookie = true;
    if (mRead.rateLimited) rateLimited = true;
    steps.push({
      step: 'models', title: 'Моделі бренду «' + brands[0].name + '»', url: mUrl, status: mRes.status,
      contentType: mRes.contentType, ok: models.length > 0,
      found: models.length ? ('моделей: ' + models.length + ' — ' + models.slice(0, 3).map((m) => m.name).join(', ')) : 'моделей не розпізнано',
      snippet: models.length ? '' : mRes.snippet, error: mRes.error || '',
    });
    if (models.length) verdict.push('✔ Збір моделей працює' + (o.cookie ? ' (з кукою)' : ' без логіну') + ': бренди й моделі читаються.');
    else if (mRead.bad) verdict.push('✖ Моделі бренду не отримано: ' + mRead.why);
    else verdict.push('✖ Бренди читаються, а моделі — ні: інша структура відповіді. Надішли уривок нижче.');
  }

  // Крок 4 — пошук за кодом (потрібен лише для автопошуку; на збір за посиланням не впливає).
  const code = String(o.code || '').trim();
  if (code) {
    const paths = o.searchPath ? [o.searchPath] : (process.env.DONOR_SEARCH_PATH ? [process.env.DONOR_SEARCH_PATH] : DEFAULT_PATHS);
    let hitPath = null;
    for (const tpl of paths) {
      const url = 'https://' + host + tpl.replace('{lang}', lang).replace('{q}', encodeURIComponent(code));
      const res = await probeFetch(url, o);
      const read = readResponse(res);
      const items = res.isJson ? itemsFromJson(res.json) : itemsFromHtml(res.text, code);
      if (read.needCookie) needCookie = true;
      if (read.rateLimited) rateLimited = true;
      steps.push({
        step: 'search', title: 'Пошук «' + code + '» шляхом ' + tpl, url, status: res.status,
        contentType: res.contentType, ok: items.length > 0,
        found: items.length ? ('знайдено: ' + items.length + ' — ' + items.slice(0, 3).map((i) => i.title).join(' | ')) : 'нічого не знайдено',
        snippet: items.length ? '' : res.snippet, error: res.error || '',
      });
      if (items.length) { hitPath = tpl; break; }
    }
    if (hitPath) verdict.push('✔ Пошук працює шляхом «' + hitPath + '». Постав його у змінну DONOR_SEARCH_PATH — тоді перебір не витрачатиме зайвих запитів.');
    else verdict.push('✖ Жоден типовий шлях пошуку не спрацював. Відкрий пошук на донорі в браузері, подивись у DevTools → Network, який запит іде, і встав його шаблон у DONOR_SEARCH_PATH (замість самого коду — {q}). Автопошук без цього не працюватиме, а збір за посиланням — працюватиме.');
  } else {
    verdict.push('· Пошук не перевіряв: не задано код запчастини. Для перевірки автопошуку впиши будь-який каталожний номер.');
  }

  if (needCookie) verdict.push('→ Візьми куку сесії з кабінету донора (DevTools → Application → Cookies) і встав її у змінну DONOR_COOKIE.');
  if (rateLimited) verdict.push('→ Донор обмежує частоту: підніми DONOR_DELAY_MS (напр. до 2000) і зачекай кілька хвилин перед наступною спробою.');

  return { host, pid, steps, verdict, needCookie, rateLimited };
}

module.exports = { probeDonor, snippet, readResponse, LOGIN_HINTS };
