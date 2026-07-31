// Тест автовизначення: ID товару зі сторінки без сліду «compatibility/<ID>»
// і адреси пошуку з форми пошуку самого сайту.
//   node test/donor-autodetect.test.js
const assert = require('assert');
const { resolvePid, idCandidates, collectDonorModels } = require('../donor');
const { searchPathFromHtml, discoverSearchPath, searchDonor } = require('../donor-search');

// Сторінка товару як на справжньому донорі: сліду «compatibility/<ID>» немає,
// натомість є кілька різних чисел, і лише одне з них — справжній ID товару.
const PRODUCT_PAGE = `<html><head>
  <script type="application/ld+json">{"@type":"Product","sku":"67050144","offers":{"price":399}}</script>
</head><body>
  <div class="cat" data-id="118">Категорія</div>
  <div class="product" data-product-id="2809"></div>
  <a href="/ua/cart/add/2809">Купити</a>
  <span>2024</span>
</body></html>`;

const HOME = `<html><body>
  <form action="/ua/subscribe"><input type="email" name="email"></form>
  <form action="/ua/search" method="get"><input type="text" name="query" placeholder="Пошук запчастин"></form>
</body></html>`;

const BRANDS = { brands: [{ id: 1, name: 'Braun', count: 2 }] };
const MODELS = { data: { models: [{ name: 'MQ 545', brand_name: 'Braun', industrial_code: '0X22111002' }] } };

let asked = [];
function install(routes) {
  asked = [];
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    const u = new URL(String(url));
    for (const [re, resp] of routes) if (re.test(u.pathname + (u.search || ''))) return resp(u);
    return { ok: false, status: 404, headers: { get: () => 'text/html' }, async text() { return 'not found'; } };
  };
}
const json = (o) => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, async text() { return JSON.stringify(o); }, async json() { return o; } });
const html = (s) => ({ ok: true, status: 200, headers: { get: () => 'text/html' }, async text() { return s; } });

const ROUTES = [
  [/^\/ua\/products\/reduktor/, () => html(PRODUCT_PAGE)],
  [/^\/ua\/api\/models\/compatibility\/2809\?brand_id=/, () => json(MODELS)],
  [/^\/ua\/api\/models\/compatibility\/2809$/, () => json(BRANDS)],
  // будь-який інший ID віддає порожнечу — саме так відсіюються хибні кандидати
  [/^\/ua\/api\/models\/compatibility\/\d+$/, () => json({ brands: [] })],
  [/^\/ua\/$/, () => html(HOME)],
  [/^\/ua\/search\?query=/, () => html('<a href="/ua/products/reduktor-braun-67050144">Кришка Braun 67050144</a>')],
];

(async () => {
  // ── кандидати ID: справжній попереду, сміття відсіяне ──
  const cands = idCandidates(PRODUCT_PAGE, 'https://d.ua/ua/products/x-67050144');
  assert.ok(cands.includes('2809'), 'ID товару має бути серед кандидатів');
  assert.ok(cands.indexOf('2809') < cands.indexOf('118'), 'data-product-id важливіший за data-id категорії');
  assert.ok(!cands.includes('2024'), 'випадкове число зі сторінки — не кандидат');

  // ── ID визначається сам: перебором із перевіркою на API ──
  install(ROUTES);
  const pid = await resolvePid('https://d.ua/ua/products/reduktor-braun-67050144', { lang: 'ua', delayMs: 0 });
  assert.strictEqual(pid, '2809');
  assert.ok(asked.some((u) => /compatibility\/2809$/.test(u)), 'кандидат перевірявся саме на API сумісності');

  // ── збір моделей за посиланням тепер працює без ручного ID ──
  install(ROUTES);
  const got = await collectDonorModels({
    host: 'd.ua', url: 'https://d.ua/ua/products/reduktor-braun-67050144',
    pid: 'https://d.ua/ua/products/reduktor-braun-67050144', delayMs: 0, lang: 'ua',
  });
  assert.strictEqual(got.pid, '2809');
  assert.strictEqual(got.models.length, 1);
  assert.strictEqual(got.models[0].model, 'MQ 545');

  // ── адреса пошуку береться з форми сайту, а не вгадується ──
  assert.strictEqual(searchPathFromHtml(HOME, 'ua'), '/ua/search?query={q}', 'форма підписки не має вигравати');
  install(ROUTES);
  assert.strictEqual(await discoverSearchPath({ host: 'd.ua', lang: 'ua' }), '/ua/search?query={q}');

  // ── пошук одразу йде знайденою адресою, без перебору типових ──
  install(ROUTES);
  const found = await searchDonor({ host: 'd.ua', code: '67050144', lang: 'ua' });
  assert.strictEqual(found.path, '/ua/search?query={q}');
  assert.strictEqual(found.items.length, 1);
  assert.strictEqual(found.items[0].confidence, 'exact');
  assert.ok(!asked.some((u) => /\/ua\/api\/search/.test(u)), 'типові шаблони не мали знадобитись');

  // ── сторінка без жодного придатного ID → зрозуміла помилка зі списком спроб ──
  install([[/^\/ua\/pusto/, () => html('<html><span>2024</span></html>')]]);
  await assert.rejects(
    resolvePid('https://d.ua/ua/pusto', { lang: 'ua', delayMs: 0 }),
    (e) => e.message === 'pid_not_found'
  );

  console.log('✔ автовизначення ID та адреси пошуку — усі перевірки пройдено');
})();
