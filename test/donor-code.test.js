// Тест витягу каталожних кодів із назв товарів — на реальних назвах із фіду lartek.
//   node test/donor-code.test.js
const assert = require('assert');
const { codesFromName } = require('../donor-code');

// [назва, бренд, очікуваний ПЕРШИЙ кандидат] — null означає «коду в назві немає».
const CASES = [
  ['Фільтр для пилососа Bosch 00491669', 'Bosch', '00491669'],
  ['Відро для хлібопічки Kenwood KW713201', 'Kenwood', 'KW713201'],
  ['Заварювальний блок для кавоварки DeLonghi 7313251451', 'DeLonghi', '7313251451'],
  ['Хрестовина бака для пральної машини Samsung DC97-15971A EBI COD.740', 'Samsung', 'DC97-15971A'],
  ['Лампа для холодильника Whirlpool 40w 481213428078', 'Whirlpool', '481213428078'],
  ['Патрубок (дозатор-бак) для пральної машини Samsung DC67-00334A', 'Samsung', 'DC67-00334A'],
  ['Панель морозильної камери (відкидна) холодильника Indesit C00268721', 'Indesit', 'C00268721'],
  ['Голівки для бритви сумісні з Philips SH50/50', 'Philips', 'SH50/50'],
  ['Ручка дверей для холодильника Bosch 00498031 L=360mm (верхня/нижня)', 'Bosch', '00498031'],
  ['Комплект панелей для гриля Tefal (TS-01043480 + TS-01043490)', 'Tefal', 'TS-01043480'],
  ['Ущільнювальна гума для морозильної камери Snaige V372100-00 (570x514mm)', 'Snaige', 'V372100-00'],
  // одиниці виміру, габарити та кількості кодом не є
  ['Концентрати для чистки Thomas Protex 1000 мл + Profloor 1000 мл', 'Thomas', null],
  ['Таймер механічний для духовки універсальний (120 хв)', 'Універсал', null],
  ['Лампочка для духовки 15W E14 (300°) SKL', '', null],
  ['Запобіжник високовольтний для НВЧ-печі 5KV 0.8A 6x40 мм', '', null],
  ['Щітки двигуна для пральної машини 12.5x5x33', 'Bosch', null],
  ['Набір фільтрів для пилососа Thomas Twin Tiger T2 T1 Genius', 'Thomas', null],
];

let bad = 0;
for (const [name, vendor, want] of CASES) {
  const got = codesFromName(name, vendor);
  const first = got.length ? got[0] : null;
  if (first !== want) {
    bad++;
    console.error(`✖ «${name}»\n   очікував: ${want}\n   отримав:  ${JSON.stringify(got)}`);
  }
}
assert.strictEqual(bad, 0, bad + ' назв розібрано неправильно');

// бренд не має ставати кодом; усі кандидати без кирилиці
const c = codesFromName('Мішки для пилососу Zelmer 49.4200 ZVCA300B 12002901', 'Zelmer');
assert.ok(!c.some((x) => /zelmer/i.test(x)), 'бренд не має потрапляти в кандидати');
assert.ok(!c.some((x) => /[А-Яа-яЇІЄҐїієґ]/.test(x)), 'кирилиці в коді не буває');
assert.ok(c.length >= 3, 'усі три коди з назви мають бути кандидатами');

console.log('✔ donor-code.js — ' + CASES.length + ' назв розібрано правильно');
