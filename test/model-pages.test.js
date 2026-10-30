// Тест сторінок моделей на зразку реального фіду lartek.
//   node test/model-pages.test.js
const assert = require('assert');
const { parseFeed, buildIndex, renderModel, renderHub, renderSitemap, makeSlug } = require('../model-pages');

const offer = (sku, cat, avail, price, ru, ua, slug) => `
  <offer id="1" group_id="1" available="${avail}">
    <url>https://lartek.com.ua/ru/${slug}/</url>
    <price>${price}</price>
    <currencyId>UAH</currencyId>
    <categoryId>${cat}</categoryId>
    <picture>https://lartek.com.ua/content/images/1/${slug}.jpg</picture>
    <vendorCode>${sku}</vendorCode>
    <vendor>LG</vendor>
    <name><![CDATA[${ru}]]></name>
    <description><![CDATA[<p>опис</p>]]></description>
    <name_ua><![CDATA[${ua}]]></name_ua>
    <description_ua><![CDATA[<p>опис <name>не назва</name></p>]]></description_ua>
  </offer>`;

const xml = `<yml_catalog><shop><categories>
  <category id="1252">Запчастини для великогабаритної техніки </category>
  <category id="1185" parentId="1252">Запчастини для пральних машин</category>
  <category id="1190" parentId="1185">Амортизатори для пральних машин</category>
  <category id="1191" parentId="1185">Ремені для пральних машин</category>
</categories><offers>
${offer('0101', 1190, 'true', 350, 'Амортизатор для стиральной машины LG', 'Амортизатор для пральної машини LG', 'amort-lg')}
${offer('0102', 1191, '', 210, 'Ремень для стиральной машины LG', 'Ремінь для пральної машини LG', 'remen-lg')}
${offer('0103', 1191, 'true', 180, 'Ремень 2 LG', 'Ремінь 2 LG', 'remen2-lg')}
</offers></shop></yml_catalog>`;

const products = parseFeed(xml);
assert.strictEqual(products.size, 3);
const p = products.get('0101');
assert.strictEqual(p.name_ru, 'Амортизатор для стиральной машины LG');
assert.strictEqual(p.name_uk, 'Амортизатор для пральної машини LG');
assert.strictEqual(p.url_uk, 'https://lartek.com.ua/amort-lg/');
assert.strictEqual(p.url_ru, 'https://lartek.com.ua/ru/amort-lg/');
assert.strictEqual(p.available, true);
assert.strictEqual(products.get('0102').available, false);
assert.strictEqual(p.type, 1185, 'тип техніки успадковується від батьківської категорії');
assert.strictEqual(p.kind_uk, 'Амортизатори');

const rows = [
  { brand: 'LG', model: 'F1020TD5', model_norm: 'F1020TD5', skus: ['0101', '0102', '0103', '9999'] },
  { brand: 'LG', model: 'F12B8', model_norm: 'F12B8', skus: ['0101', '0102', '0103'] },
  { brand: 'LG', model: 'WD', model_norm: 'WD', skus: ['0101', '0102', '0103'] },            // без цифр — відкидаємо
  { brand: 'LG', model: 'F00', model_norm: 'F00', skus: ['0101', '9998'] },                  // < 3 товарів із фіду
];
const idx = buildIndex(rows, products, 1000, 3);
assert.deepStrictEqual(idx.list.map((m) => m.slug), ['lg-f1020td5', 'lg-f12b8']);
assert.strictEqual(idx.list[0].skus.length, 3, 'товари, яких немає у фіді, не показуємо');
assert.strictEqual(makeSlug('De Longhi', 'EC685'), 'de-longhi-ec685');

const uk = renderModel(idx, products, 'lg-f1020td5', 'uk');
assert.strictEqual(uk.status, 200);
assert.strictEqual(uk.h1, 'Запчастини для пральної машини LG F1020TD5');
assert.ok(uk.title.startsWith('Запчастини для пральної машини LG F1020TD5'));
assert.ok(uk.description.includes('ціни від 180 грн'));
assert.ok(uk.html.includes('https://lartek.com.ua/amort-lg/'));
assert.ok(!uk.html.includes('/ru/amort-lg/'), 'українська сторінка веде на українські товари');
assert.ok(uk.html.indexOf('remen-lg') > uk.html.indexOf('remen2-lg'), 'спершу товари в наявності');
assert.strictEqual(uk.canonical, 'https://lartek.com.ua/modeli/lg-f1020td5/');
assert.ok(uk.html.includes('/modeli/lg-f12b8/'), 'посилання на інші моделі бренду');

const ru = renderModel(idx, products, 'lg-f1020td5', 'ru');
assert.strictEqual(ru.h1, 'Запчасти для стиральной машины LG F1020TD5');
assert.strictEqual(ru.canonical, 'https://lartek.com.ua/ru/modeli/lg-f1020td5/');
assert.ok(ru.html.includes('/ru/amort-lg/'));

const nf = renderModel(idx, products, 'lg-nope', 'uk');
assert.strictEqual(nf.status, 404);
assert.strictEqual(nf.robots, 'noindex, follow');

const hub = renderHub(idx, 'uk');
assert.ok(hub.html.includes('/modeli/lg-f1020td5/'));

const sm = renderSitemap(idx);
assert.strictEqual((sm.match(/<url>/g) || []).length, 6, 'хаб + 2 моделі, кожна в UA і RU');

// HTML-ін'єкції з назв не проходять
const evil = parseFeed(xml.replace('Амортизатор для пральної машини LG', 'А<script>x</script>'));
const idx2 = buildIndex(rows, evil, 1000, 3);
assert.ok(!renderModel(idx2, evil, 'lg-f1020td5', 'uk').html.includes('<script>x'));

assert.ok(uk.breadcrumbs.includes('breadcrumbs__list') && uk.breadcrumbs.includes('/modeli/'), 'мобільні крихти');
assert.ok(uk.breadcrumbs_desktop.includes('breadcrumbs-i') && !uk.breadcrumbs_desktop.includes('breadcrumbs__'), 'десктопні крихти');
assert.strictEqual((uk.breadcrumbs_desktop.match(/<svg/g) || []).length, 2, 'стрілки між трьома пунктами');

console.log('model-pages: OK');
