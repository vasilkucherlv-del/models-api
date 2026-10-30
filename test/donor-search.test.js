// Тест пошуку товару на донорі за кодом — на підробленому донорі (fetch підмінено).
//   node test/donor-search.test.js
const assert = require('assert');
const { searchDonor, matchDonorProduct, itemsFromJson, itemsFromHtml, confidenceOf } = require('../donor-search');

const HTML_PAGE = `<html><body>
  <a href="/ua/nasos-dlia-pralnoi-mashyny-bosch-00144978/">Насос для пральної машини Bosch 00144978</a>
  <a href="/ua/category/nasosy/">Насоси</a>
  <a href="#">нагору</a>
</body></html>`;

let seen = [];
function fakeFetch(routes) {
  return async (url) => {
    seen.push(url);
    const u = new URL(url);
    const key = u.pathname + (u.search || '');
    for (const [re, resp] of routes) if (re.test(key)) return resp();
    return { ok: false, status: 404 };
  };
}
const okHtml = (body) => () => ({ ok: true, headers: { get: () => 'text/html' }, async text() { return body; } });
const okJson = (obj) => () => ({ ok: true, headers: { get: () => 'application/json' }, async text() { return JSON.stringify(obj); } });

(async () => {
  // --- розбір JSON-відповіді ---
  const items = itemsFromJson({ result: { products: [
    { id: 51, name: 'Насос Bosch 00144978', url: '/ua/nasos/', industrial_code: '00144978' },
    { id: 52, name: 'Насос Bosch 00145787', url: '/ua/nasos-2/', industrial_code: '00145787' },
  ] } });
  assert.strictEqual(items.length, 2);
  assert.strictEqual(items[0].code, '00144978');

  // --- розбір HTML: беремо лише посилання з кодом, категорії й «#» відкидаємо ---
  const links = itemsFromHtml(HTML_PAGE, '00144978');
  assert.strictEqual(links.length, 1);
  assert.strictEqual(links[0].url, '/ua/nasos-dlia-pralnoi-mashyny-bosch-00144978/');

  // --- впевненість: код видно → exact, не видно → weak ---
  assert.strictEqual(confidenceOf({ title: 'Насос Bosch 00144978', url: '/x' }, '00144978', 'd.example'), 'exact');
  assert.strictEqual(confidenceOf({ title: 'Насос Bosch', url: '/x' }, '00144978', 'd.example'), 'weak');
  // код із роздільниками: DC97-15971A і DC9715971A — той самий код
  assert.strictEqual(confidenceOf({ title: 'Хрестовина DC9715971A', url: '/x' }, 'DC97-15971A', 'd.example'), 'exact');

  // --- пошук: перебирає шаблони, поки не знайде відповідь із товарами ---
  seen = [];
  globalThis.fetch = fakeFetch([
    [/^\/ua\/search/, () => ({ ok: false, status: 404 })],
    [/^\/ua\/api\/search/, okJson({ data: { items: [
      { id: 51, name: 'Насос Bosch 00144978', url: '/ua/nasos/', industrial_code: '00144978' },
    ] } })],
  ]);
  const r = await searchDonor({ host: 'donor.example', code: '00144978' });
  assert.strictEqual(r.path, '/{lang}/api/search?q={q}');
  assert.strictEqual(r.items.length, 1);
  assert.strictEqual(r.items[0].confidence, 'exact');
  assert.strictEqual(r.items[0].url, 'https://donor.example/ua/nasos/', 'посилання має стати абсолютним');
  assert.ok(seen.length >= 2, 'перший шаблон мав бути спробуваний і відкинутий');

  // --- підбір товару: точний збіг доводиться до pid ---
  globalThis.fetch = fakeFetch([
    [/^\/ua\/api\/search/, okJson({ items: [{ id: 0, name: 'Насос Bosch 00144978', url: '/ua/nasos/', code: '00144978' }] })],
    [/^\/ua\/nasos\//, okHtml('<html>… /ua/api/models/compatibility/4242 …</html>')],
  ]);
  const m = await matchDonorProduct({ host: 'donor.example', codes: ['00144978'] });
  assert.strictEqual(m.confidence, 'exact');
  assert.strictEqual(m.pid, '4242');

  // --- нічого не знайшлось → none, а не виняток ---
  globalThis.fetch = fakeFetch([[/.*/, () => ({ ok: true, headers: { get: () => 'text/html' }, async text() { return '<html>нічого</html>'; } })]]);
  const none = await matchDonorProduct({ host: 'donor.example', codes: ['XX999'] });
  assert.strictEqual(none.confidence, 'none');
  assert.strictEqual(none.reason, 'not_found');

  // --- товар знайшовся, але коду не видно → weak (у базу без підтвердження не піде) ---
  globalThis.fetch = fakeFetch([
    [/^\/ua\/api\/search/, okJson({ items: [{ id: 77, name: 'Насос для пральної машини', url: '/ua/nasos-x/' }] })],
    [/^\/ua\/nasos-x\//, okHtml('<html>… compatibility/7777 …</html>')],
  ]);
  const w = await matchDonorProduct({ host: 'donor.example', codes: ['00144978'] });
  assert.strictEqual(w.confidence, 'weak');
  assert.strictEqual(w.pid, '7777');

  // --- порожній код не має ходити в мережу ---
  await assert.rejects(searchDonor({ host: 'donor.example', code: '' }), /code_required/);

  console.log('✔ donor-search.js — усі перевірки пройдено');
})();
