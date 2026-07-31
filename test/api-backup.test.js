// Тест резервної копії та відновлення: GET /api/backup + POST /api/restore.
// Підроблена БД тримає таблиці в пам'яті, тож нічого зовнішнього не потрібно.
//   node test/api-backup.test.js
const assert = require('assert');
const path = require('path');

const PORT = 34568;
const KEY = 'test-key';
const MANAGER = 'manager-key';
process.env.PORT = String(PORT);
process.env.IMPORT_KEY = KEY;
process.env.MANAGER_KEY = MANAGER;
process.env.DATABASE_URL = 'postgres://fake/fake';

// ── підроблена БД: робоча таблиця + проміжна, поводяться як справжні ──
let main = [];          // compatibility
let staging = null;     // compatibility_restore (null = не існує)
let tx = null;          // знімок робочої таблиці на час транзакції

const fakeClient = {
  async query(sql, params) {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (/^BEGIN/i.test(s)) { tx = main.slice(); return { rows: [] }; }
    if (/^COMMIT/i.test(s)) { tx = null; return { rows: [] }; }
    if (/^ROLLBACK/i.test(s)) { if (tx) { main = tx; tx = null; } return { rows: [] }; }
    if (/^DROP TABLE IF EXISTS compatibility_restore/i.test(s)) { staging = null; return { rows: [] }; }
    if (/^CREATE TABLE compatibility_restore/i.test(s)) { staging = []; return { rows: [] }; }
    if (/^INSERT INTO compatibility_restore/i.test(s)) {
      if (staging === null) throw new Error('relation "compatibility_restore" does not exist');
      for (let i = 0; i < params.length; i += 6) {
        staging.push({ sku: params[i], brand: params[i + 1], model: params[i + 2], model_norm: params[i + 3], code: params[i + 4], code_norm: params[i + 5] });
      }
      return { rows: [] };
    }
    if (/^SELECT COUNT\(\*\)/i.test(s)) return { rows: [{ n: staging ? staging.length : 0 }] };
    if (/^DELETE FROM compatibility$/i.test(s)) { main = []; return { rows: [] }; }
    if (/^INSERT INTO compatibility .* SELECT DISTINCT ON/i.test(s)) {
      const seen = new Set(), out = [];
      for (const r of (staging || []).slice().sort((a, b) => (a.sku + a.model_norm).localeCompare(b.sku + b.model_norm))) {
        const k = r.sku + '|' + r.model_norm;
        if (seen.has(k)) continue;
        seen.add(k); out.push(r);
      }
      main = out;
      return { rows: [], rowCount: out.length };
    }
    if (/^SELECT sku, brand, model, code FROM compatibility ORDER BY id/i.test(s)) {
      const [limit, offset] = params;
      return { rows: main.slice(offset, offset + limit) };
    }
    if (/^SELECT DISTINCT sku/i.test(s)) return { rows: main.map((r) => ({ sku: r.sku })) };
    return { rows: [] };
  },
  release() {},
};
const fakePool = { async connect() { return fakeClient; }, async query(sql, p) { return fakeClient.query(sql, p); } };
require.cache[require.resolve('pg')] = { id: 'pg', filename: 'pg', loaded: true, exports: { Pool: function () { return fakePool; } } };

const realFetch = globalThis.fetch;
require(path.join(__dirname, '..', 'server.js'));

const base = 'http://127.0.0.1:' + PORT;
const post = async (body, k) => {
  const r = await realFetch(base + '/api/restore', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Import-Key': k || KEY }, body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};

(async () => {
  for (let i = 0; i < 50; i++) {
    try { const r = await realFetch(base + '/health'); if (r.ok) break; } catch (e) {}
    await new Promise((r) => setTimeout(r, 100));
  }

  // наповнюємо «робочу» таблицю: у моделі навмисно табуляція — вона не має поламати .tsv
  main = [
    { sku: '0873', brand: 'Bosch', model: 'WAE\t24164', code: 'WAE-1' },
    { sku: '0873', brand: 'Siemens', model: 'SN26M231', code: '' },
    { sku: '0311', brand: 'Bosch', model: 'BBZ41FGALL', code: 'C-9' },
  ];

  // ── копію віддає лише головний ключ ──
  const noKey = await realFetch(base + '/api/backup');
  assert.strictEqual(noKey.status, 401);
  const mgr = await realFetch(base + '/api/backup', { headers: { 'X-Import-Key': MANAGER } });
  assert.strictEqual(mgr.status, 401, 'ключ менеджера не має вивантажувати всю базу');

  // ── копія: заголовок, ім'я файлу, повний вміст ──
  const bak = await realFetch(base + '/api/backup', { headers: { 'X-Import-Key': KEY } });
  assert.strictEqual(bak.status, 200);
  assert.match(bak.headers.get('content-disposition') || '', /attachment; filename="compatibility-backup-\d{4}-\d{2}-\d{2}\.tsv"/);
  const text = await bak.text();
  const lines = text.replace(/^﻿/, '').trim().split('\r\n');
  assert.strictEqual(lines[0], 'sku\tbrand\tmodel\tcode');
  assert.strictEqual(lines.length, 4, 'заголовок + три рядки');
  assert.strictEqual(lines[1], '0873\tBosch\tWAE 24164\tWAE-1', 'табуляція всередині значення замінена пробілом');
  assert.strictEqual(lines[3], '0311\tBosch\tBBZ41FGALL\tC-9');

  // ── відновлення: обірване на півдорозі НЕ чіпає робочу таблицю ──
  const before = main.slice();
  await post({ start: true });
  await post({ rows: [['0999', 'LG', 'F2J3WS', '']] });
  assert.deepStrictEqual(main, before, 'до commit робоча таблиця недоторкана');
  await post({ cancel: true });
  assert.deepStrictEqual(main, before, 'скасування теж її не чіпає');
  assert.strictEqual(staging, null, 'проміжна таблиця прибрана');

  // ── повний цикл: копія → відновлення з неї ──
  const rows = lines.slice(1).map((l) => l.split('\t'));
  await post({ start: true });
  const added = await post({ rows });
  assert.strictEqual(added.body.added, 3);
  const done = await post({ commit: true });
  assert.strictEqual(done.body.restored, 3);
  assert.strictEqual(main.length, 3);
  assert.deepStrictEqual(
    main.map((r) => r.sku + '|' + r.brand + '|' + r.model).sort(),
    ['0311|Bosch|BBZ41FGALL', '0873|Bosch|WAE 24164', '0873|Siemens|SN26M231']
  );
  assert.strictEqual(staging, null);

  // ── дублі в файлі не валять відновлення (одна модель на товар) ──
  await post({ start: true });
  await post({ rows: [['5', 'B', 'M-1', ''], ['5', 'B', 'm 1', ''], ['5', 'B', 'M-2', '']] });
  const dup = await post({ commit: true });
  assert.strictEqual(dup.body.restored, 2, 'M-1 і «m 1» — та сама модель після нормалізації');

  // ── порожній файл не має стирати базу ──
  await post({ start: true });
  const empty = await post({ commit: true });
  assert.strictEqual(empty.status, 400);
  assert.strictEqual(empty.body.error, 'empty_restore');
  assert.strictEqual(main.length, 2, 'таблиця лишилась як була');

  // ── відновлення теж лише під головним ключем ──
  const mgrRes = await post({ start: true }, MANAGER);
  assert.strictEqual(mgrRes.status, 401);

  console.log('✔ /api/backup і /api/restore — усі перевірки пройдено');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
