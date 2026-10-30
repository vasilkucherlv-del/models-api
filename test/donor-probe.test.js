// Тест діагностики донора — на підробленому донорі (fetch підмінено).
// Перевіряємо саме verdict: це те, що читатиме людина під час пілота.
//   node test/donor-probe.test.js
const assert = require('assert');
const { probeDonor } = require('../donor-probe');

const json = (o) => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, async text() { return JSON.stringify(o); } });
const html = (s, status) => ({ ok: (status || 200) < 400, status: status || 200, headers: { get: () => 'text/html' }, async text() { return s; } });
const BRANDS = { brands: [{ id: 1, name: 'Bosch', count: 2 }, { id: 2, name: 'Siemens', count: 1 }] };
const MODELS = { data: { models: [{ name: 'WAE24164', brand_name: 'Bosch', industrial_code: '' }] } };

function router(routes) {
  return async (url) => {
    const u = new URL(String(url));
    for (const [re, resp] of routes) if (re.test(u.pathname + (u.search || ''))) return resp(u);
    return html('<html>нічого</html>', 404);
  };
}
const has = (v, re) => v.some((s) => re.test(s));

(async () => {
  // ── усе працює: ID зі сторінки, бренди, моделі, пошук на другому шаблоні ──
  globalThis.fetch = router([
    [/^\/ua\/tovar\/$/, () => html('<a href="/ua/api/models/compatibility/501">сумісність</a>')],
    [/compatibility\/501\?brand_id=/, () => json(MODELS)],
    [/compatibility\/501$/, () => json(BRANDS)],
    [/^\/ua\/search\?/, () => html('<html>нічого</html>')],
    [/^\/ua\/api\/search\?/, () => json({ items: [{ id: 9, name: 'Насос Bosch 00144978', url: '/ua/n/' }] })],
  ]);
  let r = await probeDonor({ host: 'donor.example', url: 'https://donor.example/ua/tovar/', code: '00144978' });
  assert.strictEqual(r.pid, '501');
  assert.strictEqual(r.steps.length, 5, 'сторінка + бренди + моделі + два шаблони пошуку');
  assert.ok(has(r.verdict, /✔ Збір моделей працює/), r.verdict.join(' | '));
  assert.ok(has(r.verdict, /Пошук працює шляхом «\/\{lang\}\/api\/search\?q=\{q\}»/), r.verdict.join(' | '));
  assert.ok(r.steps.filter((s) => s.step === 'search')[0].ok === false, 'перший шаблон мав не спрацювати');

  // ── замість даних сторінка входу → просимо куку ──
  globalThis.fetch = router([
    [/compatibility\/501/, () => html('<html><form action="/login"><input name="password"></form></html>')],
  ]);
  r = await probeDonor({ host: 'donor.example', pid: '501' });
  assert.strictEqual(r.needCookie, true);
  assert.ok(has(r.verdict, /сторінку входу|потрібна кука/), r.verdict.join(' | '));
  assert.ok(has(r.verdict, /DONOR_COOKIE/), 'вердикт має підказати, що робити');

  // ── HTTP 429 → просимо збільшити паузу ──
  globalThis.fetch = router([[/compatibility\/501/, () => html('too many', 429)]]);
  r = await probeDonor({ host: 'donor.example', pid: '501' });
  assert.strictEqual(r.rateLimited, true);
  assert.ok(has(r.verdict, /DONOR_DELAY_MS/), r.verdict.join(' | '));

  // ── JSON є, але структура інша → просимо уривок, і уривок справді доданий ──
  globalThis.fetch = router([[/compatibility\/501/, () => json({ payload: { totallyDifferent: [1, 2, 3] } })]]);
  r = await probeDonor({ host: 'donor.example', pid: '501' });
  assert.ok(has(r.verdict, /структура відповіді інша/), r.verdict.join(' | '));
  const brandsStep = r.steps.find((s) => s.step === 'brands');
  assert.strictEqual(brandsStep.ok, false);
  assert.ok(brandsStep.snippet.includes('totallyDifferent'), 'уривок потрібен, щоб полагодити розбір');

  // ── бренди читаються, моделі — ні ──
  globalThis.fetch = router([
    [/compatibility\/501\?brand_id=/, () => json({ data: { somethingElse: [] } })],
    [/compatibility\/501$/, () => json(BRANDS)],
  ]);
  r = await probeDonor({ host: 'donor.example', pid: '501' });
  assert.ok(has(r.verdict, /Бренди читаються, а моделі — ні/), r.verdict.join(' | '));

  // ── жоден шлях пошуку не спрацював: збір за посиланням усе одно робочий ──
  globalThis.fetch = router([
    [/compatibility\/501\?brand_id=/, () => json(MODELS)],
    [/compatibility\/501$/, () => json(BRANDS)],
  ]);
  r = await probeDonor({ host: 'donor.example', pid: '501', code: 'XX999' });
  assert.ok(has(r.verdict, /✔ Збір моделей працює/));
  assert.ok(has(r.verdict, /Жоден типовий шлях пошуку не спрацював/), r.verdict.join(' | '));
  assert.ok(has(r.verdict, /збір за посиланням — працюватиме/), 'треба сказати, що саме ще працює');

  // ── на сторінці немає ID → зупиняємось на першому кроці з поясненням ──
  globalThis.fetch = router([[/^\/ua\/tovar\/$/, () => html('<html>звичайна сторінка</html>')]]);
  r = await probeDonor({ host: 'donor.example', url: 'https://donor.example/ua/tovar/' });
  assert.strictEqual(r.pid, '');
  assert.strictEqual(r.steps.length, 1, 'далі йти немає сенсу');
  assert.ok(has(r.verdict, /models_<ID>\.xls/), 'треба підказати найпростіший спосіб узяти ID');

  // ── без товару взагалі — зрозуміла помилка ──
  await assert.rejects(probeDonor({ host: 'donor.example' }), /pid_or_url_required/);

  console.log('✔ donor-probe.js — усі перевірки пройдено');
})();
