// Наскрізний тест ендпойнтів /api/match-donor і /api/import-donor.
// Піднімає справжній сервер, але з підробленими БД (замість pg), фідом і донором,
// тож нічого зовнішнього не потрібно.
//   node test/api-donor.test.js
const assert = require('assert');
const path = require('path');

const PORT = 34567;
const KEY = 'test-key';
process.env.PORT = String(PORT);
process.env.IMPORT_KEY = KEY;
process.env.DATABASE_URL = 'postgres://fake/fake';
process.env.FEED_URL = 'https://feed.example/feed.xml';
process.env.DONOR_HOST = 'donor.example';
process.env.DONOR_DELAY_MS = '0';
process.env.DONOR_SEARCH_PATH = '/{lang}/api/search?q={q}';

// ── підроблена БД: запам'ятовує все, що в неї пишуть ──
const written = [];       // рядки з INSERT
const deleted = [];       // sku, для яких робили DELETE (replace)
let skusInDb = ['0873'];  // що вже «є в базі» — для режиму «яких нема»
const fakeClient = {
  async query(sql, params) {
    if (/^SELECT DISTINCT sku/i.test(sql)) return { rows: skusInDb.map((s) => ({ sku: s })) };
    if (/^DELETE FROM compatibility/i.test(sql)) { deleted.push(params[0]); return { rows: [] }; }
    if (/^INSERT INTO compatibility/i.test(sql)) {
      for (let i = 0; i < params.length; i += 6) written.push({ sku: params[i], brand: params[i + 1], model: params[i + 2], code: params[i + 4] });
      return { rows: [] };
    }
    return { rows: [] };
  },
  release() {},
};
const fakePool = { async connect() { return fakeClient; }, async query(sql, p) { return fakeClient.query(sql, p); } };
require.cache[require.resolve('pg')] = { id: 'pg', filename: 'pg', loaded: true, exports: { Pool: function () { return fakePool; } } };

// ── підроблені фід і донор; запити до самого сервера пропускаємо як є ──
const realFetch = globalThis.fetch;
const FEED = `<yml_catalog><shop><offers>
  <offer id="1"><vendorCode>0873</vendorCode><vendor>Bosch</vendor><name>Насос для пральної машини Bosch 00144978</name></offer>
  <offer id="2"><vendorCode>0311</vendorCode><vendor>Bosch</vendor><name>Фільтр для пилососа Bosch 00491669</name></offer>
  <offer id="3"><vendorCode>0999</vendorCode><vendor></vendor><name>Таймер механічний для духовки універсальний (120 хв)</name></offer>
</offers></shop></yml_catalog>`;
const DONOR_MODELS = {
  1: [{ name: 'WAE24164', brand_name: 'Bosch', industrial_code: 'WAE-1' },
      { name: 'WAE20164', brand_name: 'Bosch', industrial_code: '' }],
  2: [{ name: 'SN26M231', brand_name: 'Siemens', industrial_code: '' }],
};
const json = (o) => ({ ok: true, headers: { get: () => 'application/json' }, async text() { return JSON.stringify(o); }, async json() { return o; } });
const html = (s) => ({ ok: true, headers: { get: () => 'text/html' }, async text() { return s; } });

globalThis.fetch = async (url, opt) => {
  const u = new URL(String(url));
  if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return realFetch(url, opt);
  if (u.hostname === 'feed.example') return { ok: true, async text() { return FEED; } };
  if (u.hostname === 'donor.example') {
    if (u.pathname === '/ua/api/search') {
      const q = u.searchParams.get('q') || '';
      if (q === '00144978') return json({ items: [{ id: 5, name: 'Насос Bosch 00144978', url: '/ua/nasos-00144978/' }] });
      if (q === '00491669') return json({ items: [{ id: 6, name: 'Фільтр для пилососа Bosch', url: '/ua/filtr-x/' }] });  // код не видно → weak
      return json({ items: [] });
    }
    if (u.pathname === '/ua/nasos-00144978/') return html('<a href="/ua/api/models/compatibility/501">сумісність</a>');
    if (u.pathname === '/ua/filtr-x/') return html('<a href="/ua/api/models/compatibility/502">сумісність</a>');
    if (u.pathname.startsWith('/ua/api/models/compatibility/')) {
      const bid = u.searchParams.get('brand_id');
      if (!bid) return json({ brands: [{ id: 1, name: 'Bosch', count: 2 }, { id: 2, name: 'Siemens', count: 1 }] });
      return json({ data: { models: DONOR_MODELS[bid] || [] } });
    }
  }
  throw new Error('несподіваний запит у тесті: ' + url);
};

require(path.join(__dirname, '..', 'server.js'));

const api = async (p, body) => {
  const r = await realFetch('http://127.0.0.1:' + PORT + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Import-Key': KEY },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};

(async () => {
  for (let i = 0; i < 50; i++) {                       // чекаємо, поки сервер підніметься
    try { const r = await realFetch('http://127.0.0.1:' + PORT + '/health'); if (r.ok) break; } catch (e) {}
    await new Promise((r) => setTimeout(r, 100));
  }

  // ── без ключа не пускає ──
  const noKey = await realFetch('http://127.0.0.1:' + PORT + '/api/match-donor', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.strictEqual(noKey.status, 401);

  // ── звірка за артикулами: код береться з назви у фіді ──
  const m = await api('/api/match-donor', { skus: ['0873', '0311', '0999'] });
  assert.strictEqual(m.status, 200);
  const by = Object.fromEntries(m.body.results.map((r) => [r.sku, r]));
  assert.strictEqual(by['0873'].confidence, 'exact', 'код видно в назві знайденого товару');
  assert.strictEqual(by['0873'].code, '00144978');
  assert.strictEqual(by['0873'].pid, '501');
  assert.strictEqual(by['0311'].confidence, 'weak', 'товар є, але коду не видно');
  assert.strictEqual(by['0999'].confidence, 'none');
  assert.strictEqual(by['0999'].reason, 'no_code', 'у назві немає коду — це не помилка мережі');
  assert.deepStrictEqual([m.body.exact, m.body.weak, m.body.none], [1, 1, 1]);

  // ── режим «яких ще нема в базі»: 0873 уже є, тож беруться інші ──
  const miss = await api('/api/match-donor', { mode: 'missing', limit: 5 });
  assert.deepStrictEqual(miss.body.results.map((r) => r.sku), ['0311', '0999']);

  // ── заливка за pid зі звірки ──
  written.length = 0; deleted.length = 0;
  const imp = await api('/api/import-donor', { items: [{ sku: '0873', pid: '501' }], replace: true });
  assert.strictEqual(imp.status, 200);
  assert.strictEqual(imp.body.results[0].models, 3, 'моделі обох брендів');
  assert.strictEqual(imp.body.processed, 3);
  assert.deepStrictEqual(deleted, ['0873'], 'replace має чистити старі моделі товару');
  assert.deepStrictEqual(written.map((r) => r.model).sort(), ['SN26M231', 'WAE20164', 'WAE24164']);
  assert.strictEqual(written.find((r) => r.model === 'WAE24164').code, 'WAE-1');

  // ── перевірка без запису: віддається ВЕСЬ список (адмінка вивантажує його у .tsv) ──
  written.length = 0;
  const dry = await api('/api/import-donor', { items: [{ sku: '0873', pid: '501' }], dryRun: true });
  assert.strictEqual(dry.body.results[0].dryRun, true);
  assert.strictEqual(dry.body.results[0].sample.length, 3, 'усі зібрані моделі, а не перші кілька');
  assert.deepStrictEqual(dry.body.results[0].sample[0], { brand: 'Bosch', model: 'WAE24164', code: 'WAE-1' });
  assert.strictEqual(written.length, 0, 'у режимі перевірки в базу не пишемо');

  // ── діагностика донора: проходить ланцюг і дає вердикт ──
  const pb = await api('/api/donor-probe', { url: 'https://donor.example/ua/nasos-00144978/', code: '00144978' });
  assert.strictEqual(pb.status, 200);
  assert.strictEqual(pb.body.pid, '501');
  assert.ok(pb.body.verdict.some((v) => /✔ Збір моделей працює/.test(v)), pb.body.verdict.join(' | '));
  assert.ok(pb.body.verdict.some((v) => /Пошук працює шляхом/.test(v)), pb.body.verdict.join(' | '));
  assert.ok(pb.body.steps.length >= 3);
  const noTarget = await api('/api/donor-probe', {});
  assert.strictEqual(noTarget.status, 400, 'без товару — зрозуміла помилка, а не 500');

  // ── заливка за кодом: точний збіг проходить, слабкий — ні ──
  written.length = 0;
  const byCode = await api('/api/import-donor', { items: [{ sku: '0873', code: '00144978' }, { sku: '0311', code: '00491669' }] });
  const r0 = byCode.body.results[0], r1 = byCode.body.results[1];
  assert.strictEqual(r0.pid, '501');
  assert.strictEqual(r0.matched.confidence, 'exact');
  assert.strictEqual(r1.error, 'no_match', 'слабкий збіг без підтвердження в базу не йде');
  assert.strictEqual(r1.confidence, 'weak');
  assert.ok(!written.some((r) => r.sku === '0311'), 'для слабкого збігу нічого не записано');

  // ── слабкий збіг проходить лише з явним дозволом ──
  const weakOk = await api('/api/import-donor', { items: [{ sku: '0311', code: '00491669' }], allowWeak: true });
  assert.strictEqual(weakOk.body.results[0].pid, '502');
  assert.strictEqual(weakOk.body.results[0].matched.confidence, 'weak');

  // ── межі: більше DONOR_MAX_ITEMS товарів за раз не приймаємо ──
  const many = await api('/api/import-donor', { items: Array.from({ length: 25 }, (_, i) => ({ sku: 's' + i, pid: '501' })) });
  assert.strictEqual(many.status, 400);
  assert.strictEqual(many.body.error, 'too_many_items');

  console.log('✔ /api/match-donor і /api/import-donor — усі перевірки пройдено');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
