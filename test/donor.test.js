// Тест збору моделей із донора — на підробленому донорі (fetch підмінено),
// щоб перевірка не залежала від чужого сайту й мережі.
//   node test/donor.test.js
const assert = require('assert');
const { collectDonorModels, parseHost, resolvePid, findBrands, findModels } = require('../donor');

const BRANDS = [
  { id: 1, name: 'Bosch', count: 2 },
  { id: 2, name: 'Siemens', count: 1 },
  { id: 3, name: 'Flaky', count: 1 },
];
const MODELS = {
  1: [{ name: 'SMV68IX00D/01', brand_name: 'Bosch', industrial_code: 'BSH-1' },
      { name: 'SMS40D12EU', brand_name: 'Bosch', industrial_code: '' }],
  2: [{ name: 'SN26M231EU', brand_name: 'Siemens', industrial_code: 'SIE-9' }],
  3: [{ name: 'FLK-1', brand_name: 'Flaky', industrial_code: '' }],
};

// failUntil: скільки перших запитів до бренду 3 віддають помилку (перевірка повторів).
let calls = 0, flakyCalls = 0, failUntil = 2;
globalThis.fetch = async (url) => {
  calls++;
  const u = new URL(url);
  assert.strictEqual(u.protocol, 'https:', 'ходимо лише по https');
  if (u.pathname === '/ua/tovar-abc') {
    return { ok: true, async text() { return '<html>… /ua/api/models/compatibility/778899?x=1 …</html>'; } };
  }
  assert.strictEqual(u.pathname, '/ua/api/models/compatibility/778899');
  const bid = u.searchParams.get('brand_id');
  if (!bid) return { ok: true, async json() { return { payload: { filters: { brands: BRANDS } } }; } };
  if (bid === '3' && ++flakyCalls <= failUntil) return { ok: false, status: 503 };
  return { ok: true, async json() { return { data: { models: MODELS[bid] } }; } };
};

(async () => {
  // домен: приймаємо як домен, так і будь-яке посилання з нього; внутрішні адреси — ні
  assert.strictEqual(parseHost('https://donor.example/ua/x?y=1'), 'donor.example');
  assert.strictEqual(parseHost('Donor.Example'), 'donor.example');
  for (const bad of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.0.5', 'srv.internal', 'no-dot', '']) {
    assert.throws(() => parseHost(bad), /host/, 'мав відхилити: ' + bad);
  }

  // ID товару: число, посилання на API, сторінка товару (ID береться з HTML)
  assert.strictEqual(await resolvePid('12345', {}), '12345');
  assert.strictEqual(await resolvePid('https://donor.example/ua/api/models/compatibility/999?brand_id=2', {}), '999');
  assert.strictEqual(await resolvePid('https://donor.example/ua/tovar-abc', {}), '778899');

  // повний обхід: усі бренди, бренд із двома 503 проходить із третьої спроби
  const r = await collectDonorModels({
    host: 'https://donor.example/ua/tovar-abc',
    pid: 'https://donor.example/ua/tovar-abc',
    delayMs: 0, retryDelayMs: 0,
  });
  assert.strictEqual(r.pid, '778899');
  assert.strictEqual(r.brands, 3);
  assert.strictEqual(r.models.length, 4);
  assert.deepStrictEqual(r.models[0], { brand: 'Bosch', model: 'SMV68IX00D/01', code: 'BSH-1' });
  assert.deepStrictEqual(r.failed, []);
  assert.strictEqual(r.stopped, false);

  // ліміт часу обриває обхід, але віддає зібране, а не падає
  const r2 = await collectDonorModels({ host: 'donor.example', pid: '778899', delayMs: 50, timeBudgetMs: 1 });
  assert.ok(r2.stopped === true || r2.models.length < 4, 'мав обірватись за бюджетом часу');

  // бренд, який не віддається зовсім: він у failed, решта брендів усе одно зібрана
  flakyCalls = 0; failUntil = Infinity;
  const r3 = await collectDonorModels({ host: 'donor.example', pid: '778899', delayMs: 0, retryDelayMs: 0, retries: 2 });
  assert.deepStrictEqual(r3.failed, ['Flaky']);
  assert.strictEqual(r3.models.length, 3);
  flakyCalls = 0; failUntil = 2;

  // порожня відповідь → зрозуміла помилка, а не мовчазний нуль
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, async json() { return { data: {} }; } });
  await assert.rejects(collectDonorModels({ host: 'donor.example', pid: '1' }), /no_brands/);
  globalThis.fetch = saved;

  // пошук потрібних масивів у довільній обгортці відповіді
  assert.strictEqual(findBrands({ a: { b: BRANDS } }), BRANDS);
  assert.strictEqual(findModels({ data: { models: MODELS[1] } }), MODELS[1]);
  assert.strictEqual(findModels({ x: { y: MODELS[2] } }).length, 1, 'моделі знаходяться і поза data.models');

  console.log('✔ donor.js — усі перевірки пройдено (' + calls + ' запитів до підробленого донора)');
})();
