require('dotenv').config();
const { pool, norm, init } = require('./db');

// Імпорт сумісності прямо з YML-фіду Horoshop.
// Кожен товар має в <description> блок "Сумісний із моделями:" з парами "Бренд Модель".
// Цей скрипт витягує їх і заливає в таблицю compatibility (та сама, що й import-csv.js).
//
// Запуск:
//   node import-feed.js                       — увесь фід, залити в БД
//   node import-feed.js --dry-run             — лише розпарсити й показати статистику (без БД)
//   node import-feed.js --sku=0873            — тільки один товар (пілот)
//   node import-feed.js --sku=0873 --dry-run  — пілот, без запису
//   node import-feed.js --replace             — спершу чистити моделі товару, потім заливати
//   node import-feed.js https://.../feed.xml  — інший фід
//
// Прапорці можна комбінувати; URL фіду — перший позиційний аргумент без '--'.

const DEFAULT_FEED = 'https://www.lartek.com.ua/content/export/def50f4a67a9cdf49099014837c8ba76.xml';

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('--') && !a.includes('=')));
const opts = Object.fromEntries(
  args.filter(a => a.startsWith('--') && a.includes('='))
      .map(a => a.slice(2).split('='))
);
const FEED = args.find(a => /^https?:\/\//.test(a)) || process.env.FEED_URL || DEFAULT_FEED;
const DRY = flags.has('--dry-run');
const REPLACE = flags.has('--replace');
const ONLY_SKU = opts.sku ? String(opts.sku).trim() : null;

function clean(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

async function readSource(src) {
  const r = await fetch(src, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept': 'application/xml,text/xml,*/*'
    }
  });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' при завантаженні фіда (можливо, Horoshop заблокував сервер)');
  return await r.text();
}

// Розбирає блок сумісності з тексту опису.
// Опис у фіді — це plain text (Horoshop зрізає HTML-теги), пари йдуть підряд:
//   "... Сумісний із моделями: Бренд моделі Модель Moulinex MO151101/4Q0 Moulinex MO151301/4Q0 ..."
// Правило: бренд — слово, що починається з великої літери (без цифр);
//          модель — токен, що містить цифру (код техніки). Пари "бренд → модель".
//          На першому ж prose-слові (з малої літери) розбір зупиняється — щоб текст
//          опису ПІСЛЯ таблиці не потрапляв у моделі.
function parseCompat(descText) {
  const t = clean(descText);
  const mk = t.match(/Сумісн\S*\s+(?:із|iз|з|с)\s+моделями/i);
  if (!mk) return [];
  let tail = t.slice(mk.index + mk[0].length);
  tail = tail.replace(/^[:\s]*/, '').replace(/^Бренд\s+моделі\s+Модель\s*/i, '');

  const tokens = tail.split(' ').filter(Boolean);
  const out = [];
  let brand = null;
  const isModel = s => /\d/.test(s) && /^[A-Za-z0-9][A-Za-z0-9/.,+\-]*$/.test(s);
  const isBrand = s => /^[A-ZА-ЯЇІЄҐ][A-Za-zА-Яа-яЇЁїієґ&.\-]*$/.test(s);

  for (const tok of tokens) {
    if (isModel(tok)) {
      if (brand) out.push({ brand, model: tok });
    } else if (isBrand(tok)) {
      brand = tok;                 // новий бренд для наступних моделей
    } else {
      break;                       // prose / сміття після таблиці → кінець блоку
    }
  }
  return out;
}

// Витягує з фіду масив { sku, models:[{brand,model}] } (тільки товари з блоком сумісності).
function parseFeed(xml, onlySku) {
  const offers = xml.split('<offer').slice(1);
  const result = [];
  for (const chunk of offers) {
    const vc = chunk.match(/<vendorCode>([\s\S]*?)<\/vendorCode>/);
    if (!vc) continue;
    const sku = clean(vc[1].replace(/<!\[CDATA\[|\]\]>/g, ''));
    if (!sku) continue;
    if (onlySku && sku !== onlySku) continue;
    const dm = chunk.match(/<description>([\s\S]*?)<\/description>/);
    if (!dm) continue;
    const desc = dm[1].replace(/<!\[CDATA\[|\]\]>/g, '');
    if (!/Сумісн/i.test(desc)) continue;
    const models = parseCompat(desc);
    if (models.length) result.push({ sku, models });
  }
  return result;
}

async function main() {
  console.log('Фід:', FEED);
  console.log('Читаю фід…');
  const xml = await readSource(FEED);
  if (xml.indexOf('<offer') === -1) throw new Error('Фід не містить <offer> — віддано не XML (анти-бот заглушка або збій).');

  const products = parseFeed(xml, ONLY_SKU);
  const rows = products.reduce((n, p) => n + p.models.length, 0);
  console.log(`Товарів із сумісністю: ${products.length}; рядків моделей: ${rows}` + (ONLY_SKU ? ` (фільтр sku=${ONLY_SKU})` : ''));

  if (ONLY_SKU && products[0]) {
    const brands = {};
    products[0].models.forEach(m => { brands[m.brand] = (brands[m.brand] || 0) + 1; });
    console.log('  бренди:', Object.entries(brands).map(([b, n]) => `${b}:${n}`).join(', '));
    console.log('  приклади:', products[0].models.slice(0, 3).map(m => `${m.brand} ${m.model}`).join(' | '),
      '…', products[0].models.slice(-2).map(m => `${m.brand} ${m.model}`).join(' | '));
  }

  if (DRY) { console.log('(--dry-run) БД не чіпаю.'); return; }
  if (!process.env.DATABASE_URL) throw new Error('Немає DATABASE_URL — постав змінну, щоб залити в БД (або додай --dry-run).');

  await init();
  const client = await pool.connect();
  let ins = 0, skipped = 0;
  try {
    await client.query('BEGIN');
    for (const p of products) {
      if (REPLACE) await client.query('DELETE FROM compatibility WHERE sku = $1', [p.sku]);
      for (const m of p.models) {
        const mn = norm(m.model);
        if (!m.brand || !mn) { skipped++; continue; }
        await client.query(
          `INSERT INTO compatibility (sku, brand, model, model_norm)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (sku, model_norm)
             DO UPDATE SET brand = EXCLUDED.brand, model = EXCLUDED.model`,
          [p.sku, m.brand, m.model, mn]
        );
        ins++;
      }
    }
    await client.query('COMMIT');
    console.log(`Готово ✔ Залито рядків: ${ins}; пропущено: ${skipped}` + (REPLACE ? ' (режим replace)' : ''));
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

module.exports = { parseCompat, parseFeed };

if (require.main === module) {
  main().catch(e => { console.error('Помилка:', e.message); process.exit(1); });
}
