// Парсер HTML-таблиць сумісності з опису товару (Horoshop).
// Підтримує 2 колонки (Бренд/Марка + Модель) і 3 колонки (+ Індустріальний код),
// здвоєні макети (дві групи в рядку), дужки/пробіли в кодах.
// Якщо таблиця без заголовка або нестандартна (вставлена з Google Sheets), а звичайний
// розбір нічого не дав — вмикається дата-орієнтований резерв (parseLoose), захищений
// перевіркою «схоже на сумісність», щоб не чіпати таблиці характеристик.
// Повертає масив { brand, model, code }.

function stripTags(s) {
  return String(s == null ? '' : s)
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ').trim();
}
function cellsOf(rowHtml) {
  const out = [];
  const re = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
  let m;
  while ((m = re.exec(rowHtml))) out.push(stripTags(m[1]));
  return out;
}
function roleOf(h) {
  const t = String(h || '').toLowerCase();
  if (t.indexOf('бренд') >= 0 || t.indexOf('марка') >= 0 || t.indexOf('brand') >= 0) return 'brand';
  if (t.indexOf('індустр') >= 0 || t.indexOf('industrial') >= 0 || t.indexOf('код') >= 0) return 'code';
  if (t.indexOf('модел') >= 0 || t.indexOf('model') >= 0) return 'model';
  return 'x';
}
const HEADER_SET = new Set(['бренд','марка','модель','модел','model','brand','індустріальний код','код','індустріальний','бренд моделі','модель техніки','бренд модели']);

// Бренд: слово латиницею без цифр (Bosch, Braun, Indesit, AL-FA…).
const isBrand = s => !!s && !/\d/.test(s) && /^[A-Za-z][A-Za-z0-9&.\-\/ ]*$/.test(s);
// Відомі бренди кирилицею (латинські покриває isBrand). Додавай сюди за потреби.
const CYR_BRANDS = new Set(['атлант', 'белвар']);
const isKnownBrand = s => isBrand(s) || CYR_BRANDS.has((s || '').trim().toLowerCase());
// Модель латиницею: латинська літера+цифра (MQ7000X) або довгий числовий код (>=5 цифр).
// Для лічильника «схоже на сумісність» і рядків без бренду — щоб характеристики
// («1200 Вт») не потрапляли в моделі.
function modelLatin(s) {
  if (!s) return false;
  if (/[A-Za-z]/.test(s) && /\d/.test(s)) return true;
  if (/^\d{5,}$/.test(s)) return true;
  return false;
}
// Модель будь-якою мовою (кирилиця+цифра, напр. Атлант 35М101) — дозволена ЛИШЕ після
// відомого бренду, тож таблиці характеристик лишаються захищені.
function modelAny(s) {
  if (!s) return false;
  if (/[A-Za-zА-Яа-яЇІЄҐїієґё]/.test(s) && /\d/.test(s)) return true;
  if (/^\d{5,}$/.test(s)) return true;
  return false;
}
const modelOK = modelLatin;
const isHeaderCell = s => HEADER_SET.has((s || '').toLowerCase())
  || /бренд|марка|модел|сумісн|совмест|\bbrand\b|\bmodel\b/i.test(s || '');

// Чи схожа таблиця на список сумісності (щоб резерв не чіпав характеристики).
function looksCompat(rowsCells) {
  let models = 0;
  for (const cs of rowsCells) {
    const nz = cs.filter(c => c && c !== '&nbsp;');
    for (const c of nz) if (modelOK(c)) models++;
    for (let j = 0; j < nz.length - 1; j++) if (isKnownBrand(nz[j]) && modelAny(nz[j + 1])) return true;
  }
  return models >= 4;
}

// У резерві модель — лише латиниця+цифра БЕЗ кирилиці (інакше це проза/характеристика).
const modelLoose = s => modelOK(s) && !/[А-Яа-яЇІЄҐїієґё]/.test(s || '');

// Дата-орієнтований розбір: заголовок ігнорується, беремо самі дані.
function parseLoose(rowsCells) {
  const res = [];
  for (const raw of rowsCells) {
    const cs = raw.map(c => (c || '').trim()).filter(c => c && c !== '&nbsp;');
    if (!cs.length) continue;
    if (cs.some(isHeaderCell) && !cs.some(modelLoose)) continue;   // рядок-заголовок
    // Комбінована комірка «Бренд Модель…».
    if (cs.length === 1) {
      const one = cs[0];
      if (/[А-Яа-яЇІЄҐїієґё]/.test(one)) continue;                 // проза з кирилицею
      const m = one.match(/^([A-Za-z][A-Za-z&.\-]*(?:\s+[A-Za-z][A-Za-z&.\-]*)*)\s+(.*[A-Za-z].*\d.*|.*\d.*[A-Za-z].*)$/);
      if (m) res.push({ brand: m[1].trim(), model: m[2].trim(), code: '' });
      else if (modelLoose(one)) res.push({ brand: '', model: one, code: '' });
      continue;
    }
    // Загальний прохід: слово-бренд задає поточний бренд; код-модель — додає рядок.
    // Після ВІДОМОГО бренду дозволяємо модель кирилицею (Атлант 35М101); без бренду —
    // лише латиниця, щоб не тягнути характеристики.
    let cur = '', curKnown = false;
    for (const c of cs) {
      if (isKnownBrand(c)) { cur = c; curKnown = true; }
      else if (curKnown ? modelAny(c) : modelLoose(c)) res.push({ brand: cur, model: c, code: '' });
    }
  }
  return res;
}

function parseTables(descHtml) {
  const out = [];
  const tables = String(descHtml || '').match(/<table[\s\S]*?<\/table>/gi) || [];
  for (const tbl of tables) {
    const rows = tbl.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    if (rows.length < 1) continue;
    const rowsCells = rows.map(cellsOf);
    const before = out.length;

    // ---- Розбір за заголовком (як раніше) ----
    const header = rowsCells[0];
    const roles = header.map(roleOf);
    if (roles.indexOf('model') >= 0) {
      let bpos = roles.map((r, i) => (r === 'brand' ? i : -1)).filter(i => i >= 0);
      let G = bpos.length >= 2 ? bpos[1] - bpos[0] : roles.length;
      let start = bpos.length ? bpos[0] : 0;
      let unit = roles.slice(start, start + G);
      if (!unit.length) unit.push('model');

      // Корекція за ДАНИМИ: заголовок «Модель|Модель|…», а в рядках пари Бренд+Модель.
      if (bpos.length === 0 && rows.length > 1) {
        const probe = rowsCells[1].filter(c => c !== '');
        const brandLike = s => s && !/\d/.test(s) && /^[A-Za-zА-Яа-яЇІЄҐїієґё&.\- ]+$/.test(s);
        const modelLike = s => s && /\d/.test(s);
        if (probe.length >= 2 && probe.length % 2 === 0) {
          let paired = true;
          for (let j = 0; j < probe.length; j += 2) {
            if (!brandLike(probe[j]) || !modelLike(probe[j + 1])) { paired = false; break; }
          }
          if (paired) { G = 2; start = 0; unit = ['brand', 'model']; }
        }
      }
      for (let ri = 1; ri < rows.length; ri++) {
        const cs = rowsCells[ri];
        for (let k = 0; k < cs.length; k += G) {
          const grp = cs.slice(k, k + G);
          const d = {};
          for (let j = 0; j < unit.length; j++) {
            if (j < grp.length && unit[j] !== 'x' && d[unit[j]] === undefined) d[unit[j]] = grp[j];
          }
          const model = (d.model || '').trim();
          if (!model) continue;
          if (HEADER_SET.has(model.toLowerCase())) continue;   // пропустити повторені заголовки
          out.push({ brand: (d.brand || '').trim(), model, code: (d.code || '').trim() });
        }
      }
    }

    // ---- Резерв для таблиць без заголовка/нестандартних: лише якщо звичайний розбір
    //      нічого не дав І таблиця схожа на сумісність (щоб не чіпати характеристики) ----
    if (out.length === before && looksCompat(rowsCells)) {
      for (const r of parseLoose(rowsCells)) out.push(r);
    }
  }
  return out;
}

module.exports = { parseTables, stripTags };
