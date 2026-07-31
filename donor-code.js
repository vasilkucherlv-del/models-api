// Витяг каталожних номерів (кодів виробника) з назви товару.
//
// Потрібен для автопошуку на сайті-донорі: у фіді Horoshop назва товару містить код,
// за яким той самий товар шукається в донора, напр.
//   «Фільтр для пилососа Bosch 00491669»                    → 00491669
//   «Хрестовина бака … Samsung DC97-15971A EBI COD.740»      → DC97-15971A, COD.740
//   «Ремінь для пральної машини LG 1173J5 EL 4400FR3116A»    → 4400FR3116A, 1173J5
//
// Повертає СПИСОК кандидатів, найімовірніший — першим. Пошук на донорі пробує їх по черзі
// й зупиняється на точному збігу, тож зайвий кандидат нічого не псує, а пропущений —
// псує (товар не знайдеться). Тому правила радше пропускають зайве, ніж ріжуть потрібне.

// Одиниці виміру та службові позначки — це не код (50g, 15W, 1000мл, 5KV, 0.8A, 40w…).
const UNIT = /^\d+([.,]\d+)?(g|гр|г|kg|кг|w|вт|kv|кв|v|в|a|а|hz|гц|ml|мл|l|л|mg|мг|mm|мм|cm|см|m|м|шт|pcs|°|°c)$/i;
// Габарити та розміри: 12.5x5x33, 570x514mm, 6x40 — не код.
const DIMS = /\d\s*[x×х]\s*\d/i;
// Явно не код: L=360mm, (4шт.), 100%
const JUNK = /[=%]/;

const digits = (s) => (s.match(/\d/g) || []).length;
const letters = (s) => (s.match(/[A-Za-z]/g) || []).length;

// Токен-кандидат: обрізаємо декоративну пунктуацію по краях, лишаючи всередині «-», «.», «/».
function trim(tok) {
  return String(tok || '').replace(/^[^0-9A-Za-z]+/, '').replace(/[^0-9A-Za-z%]+$/, '');
}

function isCandidate(tok) {
  if (!tok || tok.length < 4) return false;
  if (JUNK.test(tok)) return false;
  if (DIMS.test(tok)) return false;
  if (UNIT.test(tok)) return false;
  if (/[А-Яа-яЇІЄҐїієґ]/.test(tok)) return false;         // кирилиця в коді не буває
  const d = digits(tok);
  if (!d) return false;                                   // без цифр — це слово, не код
  // Чисто числовий токен — код лише від 5 цифр. Інакше це обʼєм/потужність/кількість,
  // у якої одиниця стоїть окремим словом («Protex 1000 мл», «(120 хв)»).
  if (/^\d+$/.test(tok)) return d >= 5;
  if (d >= 4) return true;                                // DC97-15971A, 49.4200, 4400FR3116A
  return tok.length >= 6 && letters(tok) > 0;             // ZVCA300B, DLSC005
}

// Чим більше схоже на каталожний номер, тим вищий бал (сортування кандидатів).
function score(tok) {
  const d = digits(tok);
  let s = d * 2;
  if (/^\d+$/.test(tok) && d >= 6 && d <= 13) s += 12;    // 00491669, 481213428078
  if (/^[A-Z]{1,3}\d{2,}[-.]?\d*[A-Z]?$/i.test(tok)) s += 8;   // DC97-15971A, C00109633, KW713201
  if (/[-.]/.test(tok)) s += 2;                           // складені коди
  if (tok.length >= 6) s += 2;
  if (d <= 3) s -= 6;                                     // слабкі кандидати — в кінець
  return s;
}

// Головна функція: назва товару (+ бренд, щоб не сплутати його з кодом) → кандидати коду.
function codesFromName(name, vendor) {
  const raw = String(name || '');
  const vend = String(vendor || '').trim().toLowerCase();
  const out = [];
  const seen = new Set();
  // «/» НЕ роздільник: коди голівок для бритв саме такі — SH50/50, HQ8/50, S740/80.
  for (const part of raw.split(/[\s,;()\[\]+]+/)) {
    const tok = trim(part);
    if (!tok) continue;
    if (tok.toLowerCase() === vend) continue;
    if (!isCandidate(tok)) continue;
    const key = tok.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tok);
  }
  return out.sort((a, b) => score(b) - score(a));
}

module.exports = { codesFromName, isCandidate, score };
