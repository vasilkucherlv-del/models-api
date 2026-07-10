// Парсер HTML-таблиць сумісності з опису товару (Horoshop).
// Підтримує 2 колонки (Бренд/Марка + Модель) і 3 колонки (+ Індустріальний код),
// здвоєні макети (дві групи в рядку), дужки/пробіли в кодах.
// Повертає масив { brand, model, code }.

function stripTags(s) {
  return String(s == null ? '' : s)
    .replace(/<[^>]+>/g, '')
    .replace(/ |&nbsp;/g, ' ')
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
const HEADER_SET = new Set(['бренд','марка','модель','модел','model','brand','індустріальний код','код','індустріальний','бренд моделі','модель техніки']);

function parseTables(descHtml) {
  const out = [];
  const tables = String(descHtml || '').match(/<table[\s\S]*?<\/table>/gi) || [];
  for (const tbl of tables) {
    const rows = tbl.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    if (rows.length < 2) continue;
    const header = cellsOf(rows[0]);
    const roles = header.map(roleOf);
    if (roles.indexOf('model') < 0) continue;               // не таблиця сумісності
    const bpos = roles.map((r, i) => (r === 'brand' ? i : -1)).filter(i => i >= 0);
    const G = bpos.length >= 2 ? bpos[1] - bpos[0] : roles.length;
    const start = bpos.length ? bpos[0] : 0;
    const unit = roles.slice(start, start + G);
    if (!unit.length) unit.push('model');
    for (let ri = 1; ri < rows.length; ri++) {
      const cs = cellsOf(rows[ri]);
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
  return out;
}

module.exports = { parseTables, stripTags };
