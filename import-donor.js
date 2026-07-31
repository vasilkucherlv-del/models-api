require('dotenv').config();
const fs = require('fs');
const { collectDonorModels } = require('./donor');
const { matchDonorProduct } = require('./donor-search');
const { codesFromName } = require('./donor-code');

// Збір сумісних моделей із сайту-донора і заливка їх у базу через API —
// те саме, що робила закладка в браузері, але без браузера і одразу для багатьох товарів.
// Запасний шлях до кнопки в /admin: ходить із ТВОЄЇ мережі, тож придатний, якщо донор
// ріже серверні IP.
//
// За посиланням/ID (точно, без пошуку):
//   node import-donor.js --host=donor.example --pid=12345 --sku=0873 --dry-run
//   node import-donor.js --host=donor.example --url="https://donor.example/ua/tovar" --sku=0873 \
//        --api=https://models-api.up.railway.app --key=<IMPORT_KEY> --replace
//
// Пачкою з файлу (рядки «артикул<TAB>ID-або-посилання», '#' — коментар):
//   node import-donor.js --host=donor.example --list=pairs.tsv --api=... --key=... --replace
//
// Автопошук за каталожним кодом:
//   node import-donor.js --host=donor.example --sku=0873 --code=00144978 --search --dry-run
//   node import-donor.js --host=donor.example --from-feed=20 --missing --search --api=... --key=...
//     --from-feed[=N]  взяти товари з фіду lartek (код витягується з назви)
//     --missing        лише ті артикули, яких ще нема в базі (питає $API/api/skus)
//     --allow-weak     дозволити слабкі збіги (за замовч. заливаються лише точні)
//
// Інші прапорці:
//   --dry-run   нічого не пише в базу; показує, що знайшлось
//   --out=f.tsv зберегти зібране у файл (Бренд/Модель/Код — як вивантаження закладки)
//   --replace   спершу почистити наявні моделі товару
//   --delay=1000 пауза між запитами до донора, мс
//   --lang=ua   мовний префікс у шляху API донора
//   --cookie="" Cookie сесії донора, якщо без неї API не віддає дані
//
// Змінні оточення: DONOR_HOST, DONOR_COOKIE, DONOR_SEARCH_PATH, MODELS_API_URL,
// MODELS_API_KEY (або IMPORT_KEY), FEED_URL.

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--') && !a.includes('=')));
const opts = Object.fromEntries(
  argv.filter((a) => a.startsWith('--') && a.includes('='))
      .map((a) => { const i = a.indexOf('='); return [a.slice(2, i), a.slice(i + 1)]; })
);

const HOST = opts.host || process.env.DONOR_HOST || '';
const COOKIE = opts.cookie || process.env.DONOR_COOKIE || '';
const API = (opts.api || process.env.MODELS_API_URL || '').replace(/\/+$/, '');
const KEY = opts.key || process.env.MODELS_API_KEY || process.env.IMPORT_KEY || '';
const DRY = flags.has('--dry-run');
const REPLACE = flags.has('--replace');
const SEARCH = flags.has('--search') || 'code' in opts || 'from-feed' in opts || flags.has('--from-feed');
const ALLOW_WEAK = flags.has('--allow-weak');
const MISSING = flags.has('--missing');
const DELAY = parseInt(opts.delay || '1000', 10);
const LANG = opts.lang || 'ua';
const FEED = process.env.FEED_URL ||
  'https://www.lartek.com.ua/content/export/def50f4a67a9cdf49099014837c8ba76.xml';

function die(msg) { console.error('✖ ' + msg); process.exit(1); }

async function apiGet(p) {
  if (!API) die('вкажи --api=https://<домен-models-api> (або MODELS_API_URL)');
  if (!KEY) die('вкажи --key=<IMPORT_KEY> (або MODELS_API_KEY)');
  const r = await fetch(API + p, { headers: { 'X-Import-Key': KEY } });
  if (!r.ok) throw new Error('API ' + r.status + ' на ' + p);
  return r.json();
}

// Товари з фіду lartek: артикул + назва (у ній лежить каталожний код) + бренд.
async function jobsFromFeed(limit) {
  const r = await fetch(FEED, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', 'Accept': 'application/xml,text/xml,*/*' }
  });
  if (!r.ok) throw new Error('фід недоступний (HTTP ' + r.status + ')');
  const xml = await r.text();
  const cd = (s) => String(s || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/\s+/g, ' ').trim();

  let skip = null;
  if (MISSING) {
    const d = await apiGet('/api/skus');
    skip = new Set(d.skus || []);
    console.log('У базі вже є артикулів: ' + skip.size + ' — їх пропускаю.');
  }

  const jobs = [];
  for (const off of xml.split('<offer').slice(1)) {
    const vc = off.match(/<vendorCode>([\s\S]*?)<\/vendorCode>/);
    const nm = off.match(/<name>([\s\S]*?)<\/name>/);
    if (!vc || !nm) continue;
    const sku = cd(vc[1]);
    if (!sku || (skip && skip.has(sku))) continue;
    const vd = off.match(/<vendor>([\s\S]*?)<\/vendor>/);
    jobs.push({ sku, name: cd(nm[1]), vendor: vd ? cd(vd[1]) : '' });
    if (limit && jobs.length >= limit) break;
  }
  return jobs;
}

// Товари з файлу --list або з окремих прапорців.
function jobsFromArgs() {
  if (opts.list) {
    const text = fs.readFileSync(opts.list, 'utf8').replace(/^﻿/, '');
    const jobs = [];
    text.split(/\r\n|\r|\n/).forEach((line, i) => {
      const l = line.trim();
      if (!l || l.startsWith('#')) return;
      const parts = l.split(/\t|;|,/).map((s) => s.trim()).filter(Boolean);
      if (parts.length < 2) die(`рядок ${i + 1} у --list: очікую «артикул<TAB>ID-посилання-або-код»`);
      jobs.push(SEARCH ? { sku: parts[0], codes: [parts[1]] } : { sku: parts[0], pid: parts[1] });
    });
    return jobs;
  }
  const sku = (opts.sku || '').trim();
  const pid = (opts.pid || opts.url || argv.find((a) => !a.startsWith('--')) || '').trim();
  const code = (opts.code || '').trim();
  if (!pid && !code) die('вкажи --pid=<ID>, --url=<посилання> або --code=<каталожний код> (чи --list=/--from-feed)');
  if (!sku && !DRY) die('вкажи --sku=<твій артикул> (без нього нема куди заливати)');
  return [code ? { sku, codes: [code] } : { sku, pid }];
}

function toTsv(rows, withSku) {
  const head = (withSku ? ['Артикул', 'Бренд', 'Модель', 'Код'] : ['Бренд', 'Модель', 'Код']).join('\t');
  const body = rows.map((r) => (withSku ? [r.sku, r.brand, r.model, r.code] : [r.brand, r.model, r.code]).join('\t'));
  return '﻿' + [head].concat(body).join('\r\n');
}

async function pushToApi(sku, models) {
  if (!API) die('нема куди заливати: додай --api=https://<домен-models-api> (або MODELS_API_URL)');
  if (!KEY) die('нема ключа: додай --key=<IMPORT_KEY> (або MODELS_API_KEY)');
  const r = await fetch(API + '/api/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Import-Key': KEY },
    body: JSON.stringify({ sku, replace: REPLACE, models }),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error('API ' + r.status + ': ' + txt.slice(0, 200));
  try { return JSON.parse(txt); } catch (e) { return { raw: txt }; }
}

(async () => {
  if (!HOST) die('вкажи --host=<домен донора> (або DONOR_HOST)');

  const fromFeed = flags.has('--from-feed') || 'from-feed' in opts;
  const jobs = fromFeed
    ? await jobsFromFeed(parseInt(opts['from-feed'] || '20', 10) || 20)
    : jobsFromArgs();
  if (!jobs.length) die('нема чого робити: список товарів порожній');

  const all = [];
  let totalWritten = 0, skipped = 0;

  for (let j = 0; j < jobs.length; j++) {
    const job = jobs[j];
    const tag = `[${j + 1}/${jobs.length}] ${job.sku || '(без артикулу)'}`;
    try {
      // Крок 1 — знайти товар на донорі, якщо задано не ID, а код чи назву.
      if (!job.pid) {
        const codes = job.codes && job.codes.length ? job.codes : codesFromName(job.name, job.vendor);
        if (!codes.length) { console.log(`${tag}: — у назві нема каталожного коду, пропускаю`); skipped++; continue; }
        const m = await matchDonorProduct({ host: HOST, codes, cookie: COOKIE, lang: LANG, delayMs: DELAY });
        if (!m.pid || (m.confidence !== 'exact' && !ALLOW_WEAK)) {
          console.log(`${tag}: — не знайдено (${m.confidence}${m.reason ? ', ' + m.reason : ''}), код ${codes[0]}`);
          skipped++; continue;
        }
        job.pid = m.pid;
        console.log(`${tag}: знайдено «${m.title}» (${m.confidence}, код ${m.code}) → ID ${m.pid}`);
      }

      // Крок 2 — забрати моделі всіх брендів цього товару.
      const res = await collectDonorModels({
        host: HOST, pid: job.pid, cookie: COOKIE, delayMs: DELAY, lang: LANG,
        onProgress: (p) => process.stderr.write(`\r${tag}: ${p.done}/${p.total} ${p.brand} — ${p.models} моделей   `),
      });
      process.stderr.write('\n');

      res.models.forEach((m) => all.push(Object.assign({ sku: job.sku }, m)));
      const note = [];
      if (res.failed.length) note.push('не віддали: ' + res.failed.join(', '));
      if (res.stopped) note.push('обірвано за лімітом');
      const suffix = note.length ? ' (' + note.join('; ') + ')' : '';

      if (DRY) {
        console.log(`${tag}: ${res.models.length} моделей із ${res.brands} брендів${suffix} — пробний запуск, у базу не пишу`);
      } else {
        const out = await pushToApi(job.sku, res.models);
        totalWritten += out.processed || 0;
        console.log(`${tag}: ${res.models.length} моделей із ${res.brands} брендів → у базу ${out.processed}${suffix}`);
      }
    } catch (e) {
      process.stderr.write('\n');
      console.error(`${tag}: ✖ ${e.message}`);
    }
  }

  if (opts.out) {
    fs.writeFileSync(opts.out, toTsv(all, jobs.length > 1), 'utf8');
    console.log('Файл: ' + opts.out + ' (' + all.length + ' рядків)');
  }
  console.log(DRY
    ? `Пробний запуск завершено. Товарів пропущено: ${skipped}.`
    : `Готово. Записано рядків: ${totalWritten}; товарів пропущено: ${skipped}.`);
})().catch((e) => die(e.message));
