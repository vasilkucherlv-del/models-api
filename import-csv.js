require('dotenv').config();
const fs = require('fs');
const { parse } = require('csv-parse/sync');
const { pool, norm, init } = require('./db');

// Імпорт даних із CSV. Колонки: sku,brand,model
// Запуск: node import-csv.js sample.csv
async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Вкажи CSV-файл: node import-csv.js data.csv');
    process.exit(1);
  }

  await init();

  const text = fs.readFileSync(file, 'utf8');
  const records = parse(text, { columns: true, skip_empty_lines: true, trim: true });

  const client = await pool.connect();
  let n = 0, skipped = 0;
  try {
    await client.query('BEGIN');
    for (const r of records) {
      const sku = (r.sku || '').trim();
      const brand = (r.brand || '').trim();
      const model = (r.model || '').trim();
      const mn = norm(model);
      if (!sku || !brand || !mn) { skipped++; continue; }
      await client.query(
        `INSERT INTO compatibility (sku, brand, model, model_norm)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (sku, model_norm)
         DO UPDATE SET brand = EXCLUDED.brand, model = EXCLUDED.model`,
        [sku, brand, model, mn]
      );
      n++;
    }
    await client.query('COMMIT');
    console.log(`Імпортовано рядків: ${n}; пропущено: ${skipped}`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
  } finally {
    client.release();
    await pool.end();
  }
}
main();
