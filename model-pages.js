// Сторінки «Запчастини для <модель техніки>» — для пошуковиків і покупців.
//
// Як це працює:
//   • Дані: таблиця compatibility (які товари підходять до якої моделі) +
//     російський фід Horoshop (у ньому є і RU, і UA назви, ціна, фото, наявність).
//   • Беремо ТОП моделей за кількістю наших товарів (за замовчуванням 1000,
//     лише моделі, до яких підходить щонайменше 3 товари з фіду).
//   • Сервер віддає ГОТОВИЙ вміст сторінки (заголовок, опис, HTML, хлібні крихти).
//     Cloudflare Worker на lartek.com.ua/modeli/* вставляє його в шаблон
//     звичайної сторінки Horoshop — тож меню, кошик і футер ті самі, що на сайті,
//     і на десктопі, і на мобільній версії.
//
// Адреси: /modeli/ (каталог моделей), /modeli/<бренд>-<модель>/ ; RU — з префіксом /ru.

const SITE = 'https://lartek.com.ua';
const RU_FEED = process.env.RU_FEED_URL ||
  'https://lartek.com.ua/content/export/4afcdcba6dc44bbcf68db6be51f8d018.xml';
const LIMIT = parseInt(process.env.MODEL_PAGES_LIMIT || '1000', 10);
const MIN_PRODUCTS = parseInt(process.env.MODEL_PAGES_MIN || '3', 10);
const TTL_MS = 6 * 60 * 60 * 1000;

// Тип техніки за категорією-«запчастини для …» (родовий відмінок, однина).
// Ключ — id категорії з фіду; дочірні категорії успадковують тип батьківської.
const TYPES = {
  1185: ['пральної машини', 'стиральной машины'],
  1224: ['плити та духовки', 'плиты и духовки'],
  1205: ['холодильника', 'холодильника'],
  1234: ['посудомийної машини', 'посудомоечной машины'],
  1244: ['бойлера', 'бойлера'],
  1239: ['витяжки', 'вытяжки'],
  1243: ['сушильної машини', 'сушильной машины'],
  1108: ["м'ясорубки", 'мясорубки'],
  1078: ['кухонного комбайна', 'кухонного комбайна'],
  1138: ['блендера', 'блендера'],
  1127: ['мультиварки', 'мультиварки'],
  1124: ['мікрохвильової печі', 'микроволновой печи'],
  1137: ['електрогриля', 'электрогриля'],
  1150: ['хлібопічки', 'хлебопечки'],
  1179: ['міксера', 'миксера'],
  1237: ['соковижималки', 'соковыжималки'],
  1241: ['кавомолки', 'кофемолки'],
  1242: ['пароварки', 'пароварки'],
  1055: ['пилососа', 'пылесоса'],
  1155: ['кавоварки', 'кофеварки'],
  1097: ['бритви', 'бритвы'],
  1091: ['машинки для стрижки', 'машинки для стрижки'],
  1107: ['зволожувача повітря', 'увлажнителя воздуха'],
  1126: ['зубної щітки', 'зубной щетки'],
  1184: ['праски', 'утюга'],
  1240: ['обігрівача', 'обогревателя'],
};

const T = {
  uk: {
    home: 'Головна', hub: 'Запчастини за моделлю техніки', parts: 'Запчастини для',
    inStock: 'В наявності', outStock: 'Немає в наявності', uah: 'грн',
    goods: (n) => n + ' ' + plural(n, 'товар', 'товари', 'товарів'),
    models: (n) => n + ' ' + plural(n, 'модель', 'моделі', 'моделей'),
    intro: (name, n) => `Тут зібрано ${n} ${plural(n, 'запчастину', 'запчастини', 'запчастин')} та аксесуари, сумісні з <strong>${name}</strong>. ` +
      'Сумісність перевірена за каталожними номерами виробника. Перед замовленням звірте модель на шильдику техніки — ' +
      'якщо сумніваєтесь, напишіть нам номер моделі, і менеджер підтвердить, що деталь підійде.',
    other: (b) => 'Інші моделі ' + b,
    all: 'Усі моделі техніки',
    hubIntro: 'Оберіть бренд і модель своєї техніки — покажемо всі запчастини, які до неї підходять. ' +
      'Номер моделі зазвичай написаний на шильдику: на задній стінці, під кришкою або на дні приладу.',
    notFound: 'Модель не знайдено', notFoundText: 'Такої сторінки немає. Перегляньте список моделей або скористайтеся пошуком на сайті.',
    titleTail: ' — купити в Україні | LARTEK',
    desc: (name, n, min, kinds) => `Запчастини для ${name}: ${kinds ? kinds + '. ' : ''}${n} ${plural(n, 'товар', 'товари', 'товарів')}, ціни від ${min} грн. Перевірена сумісність, доставка по Україні — LARTEK.`,
    hubDesc: 'Запчастини до побутової техніки за моделлю: оберіть бренд і модель — покажемо сумісні деталі. Доставка по Україні — LARTEK.',
  },
  ru: {
    home: 'Главная', hub: 'Запчасти по модели техники', parts: 'Запчасти для',
    inStock: 'В наличии', outStock: 'Нет в наличии', uah: 'грн',
    goods: (n) => n + ' ' + plural(n, 'товар', 'товара', 'товаров'),
    models: (n) => n + ' ' + plural(n, 'модель', 'модели', 'моделей'),
    intro: (name, n) => `Здесь собрано ${n} ${plural(n, 'запчасть', 'запчасти', 'запчастей')} и аксессуары, совместимые с <strong>${name}</strong>. ` +
      'Совместимость проверена по каталожным номерам производителя. Перед заказом сверьте модель на шильдике техники — ' +
      'если сомневаетесь, напишите нам номер модели, и менеджер подтвердит, что деталь подойдёт.',
    other: (b) => 'Другие модели ' + b,
    all: 'Все модели техники',
    hubIntro: 'Выберите бренд и модель своей техники — покажем все запчасти, которые к ней подходят. ' +
      'Номер модели обычно указан на шильдике: на задней стенке, под крышкой или на дне прибора.',
    notFound: 'Модель не найдена', notFoundText: 'Такой страницы нет. Посмотрите список моделей или воспользуйтесь поиском на сайте.',
    titleTail: ' — купить в Украине | LARTEK',
    desc: (name, n, min) => `Запчасти для ${name}: ${n} ${plural(n, 'товар', 'товара', 'товаров')}, цены от ${min} грн. Проверенная совместимость, доставка по Украине — LARTEK.`,
    hubDesc: 'Запчасти для бытовой техники по модели: выберите бренд и модель — покажем совместимые детали. Доставка по Украине — LARTEK.',
  },
};

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const TR = { а:'a',б:'b',в:'v',г:'h',ґ:'g',д:'d',е:'e',є:'ie',ж:'zh',з:'z',и:'y',і:'i',ї:'i',й:'i',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'kh',ц:'ts',ч:'ch',ш:'sh',щ:'shch',ь:'',ю:'iu',я:'ia',ы:'y',э:'e',ё:'e',ъ:'' };
function slugPart(s) {
  return String(s || '').toLowerCase().split('').map((c) => (c in TR ? TR[c] : c)).join('')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
const makeSlug = (brand, modelNorm) => slugPart(brand) + '-' + String(modelNorm).toLowerCase();

const pathFor = (lang, slug) => (lang === 'ru' ? '/ru' : '') + '/modeli/' + (slug ? slug + '/' : '');

// ── Фід: sku → товар (обидві мови) + тип техніки за категорією ──
function parseFeed(xml) {
  const cd = (s) => String(s || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/\s+/g, ' ').trim();
  const parent = {}, catName = {};
  for (const m of xml.matchAll(/<category id="(\d+)"(?: parentId="(\d+)")?>([^<]*)<\/category>/g)) {
    parent[m[1]] = m[2] || null; catName[m[1]] = cd(m[3]);
  }
  const typeOf = (id) => { let c = id, guard = 0; while (c && guard++ < 10) { if (TYPES[c]) return Number(c); c = parent[c]; } return null; };
  const products = new Map();
  for (const off of xml.split('<offer').slice(1)) {
    const g = (tag) => { const m = off.match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>')); return m ? cd(m[1]) : ''; };
    const sku = g('vendorCode'); const urlRu = g('url');
    if (!sku || !urlRu) continue;
    const cat = g('categoryId');
    const leaf = catName[cat] || '';
    products.set(sku, {
      sku,
      name_ru: g('name'), name_uk: g('name_ua') || g('name'),
      url_ru: urlRu, url_uk: urlRu.replace(/^(https?:\/\/[^/]+)\/ru\//, '$1/'),
      price: Number(g('price')) || 0,
      picture: g('picture'),
      available: /available="true"/.test(off.slice(0, 200)),
      type: typeOf(cat),
      kind_uk: leaf.split(/\s+для\s+/i)[0].trim(),   // «Амортизатори для пральних машин» → «Амортизатори»
    });
  }
  return products;
}

// ── Індекс сторінок із рядків БД ──
// rows: [{brand, model, model_norm, skus:[...]}] — вже згруповані по (бренд, модель)
function buildIndex(rows, products, limit = LIMIT, min = MIN_PRODUCTS) {
  const list = [];
  const seen = new Set();
  for (const r of rows) {
    if (!/\d/.test(r.model_norm) || r.model_norm.length < 3 || !r.brand) continue;
    const skus = [...new Set(r.skus)].filter((s) => products.has(s));
    if (skus.length < min) continue;
    const slug = makeSlug(r.brand, r.model_norm);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    // тип техніки — найчастіший серед товарів моделі
    const cnt = {};
    for (const s of skus) { const t = products.get(s).type; if (t) cnt[t] = (cnt[t] || 0) + 1; }
    const type = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0] || null;
    list.push({ slug, brand: r.brand, model: r.model, skus, type: type ? Number(type) : null });
  }
  list.sort((a, b) => b.skus.length - a.skus.length || a.slug.localeCompare(b.slug));
  const top = list.slice(0, limit);
  return { list: top, bySlug: new Map(top.map((m) => [m.slug, m])) };
}

function modelName(m) { return m.brand + ' ' + m.model; }
function typeGen(m, lang) { return m.type && TYPES[m.type] ? TYPES[m.type][lang === 'ru' ? 1 : 0] : ''; }

function crumbs(lang, items) {
  // Розмітка як у Horoshop. Шаблони різні: мобільний — breadcrumbs__*, десктоп — breadcrumbs-i.
  const home = SITE + (lang === 'ru' ? '/ru/' : '/');
  const pos = (i) => `<meta itemprop="position" content="${i + 1}">`;
  const li = 'itemprop="itemListElement" itemscope itemtype="https://schema.org/ListItem"';
  const mArrow = '<svg class="icon icon--arrow-right"><use xlink:href="#icon-arrow-right"></use></svg>';
  const mobile = '<div class="breadcrumbs__list-wrap"><div class="breadcrumbs__list">' + items.map((it, i) => {
    const inner = i === 0
      ? `<a class="breadcrumbs__link" itemprop="item" href="${home}" aria-label="${esc(it.name)}"><meta itemprop="name" content="${esc(it.name)}"><svg class="icon icon--homepage"><use xlink:href="#icon-homepage"></use></svg></a>`
      : it.url
        ? `<a class="breadcrumbs__link" itemprop="item" href="${SITE}${it.url}"><span itemprop="name">${esc(it.name)}</span></a>`
        : `<span class="breadcrumbs__link" itemprop="item" content="${SITE}${it.self}"><span itemprop="name">${esc(it.name)}</span></span>`;
    return (i ? mArrow : '') + `<div class="breadcrumbs__item" ${li}>${inner}${pos(i)}</div>`;
  }).join('') + '</div></div>';
  const dArrow = '<svg class="icon icon--breadcrumbs-arrow"><use xlink:href="#icon-breadcrumbs-arrow"></use></svg>';
  const desktop = items.map((it, i) => {
    const last = i === items.length - 1;
    const href = i === 0 ? home : it.url ? SITE + it.url : '';
    const inner = href && !last
      ? `<a itemprop="item" href="${href}"><span itemprop="name">${esc(it.name)}</span></a>`
      : `<span itemprop="item" content="${SITE}${it.self || it.url || '/'}"><span itemprop="name">${esc(it.name)}</span></span>`;
    return `<div class="breadcrumbs-i" ${li}>${inner}${pos(i)}${last ? '' : dArrow}</div>`;
  }).join('');
  return { mobile, desktop };
}

const crumbsOut = (c) => ({ breadcrumbs: c.mobile, breadcrumbs_desktop: c.desktop });

const STYLE = '<style>' +
  '.lmp-intro{margin:0 0 20px;line-height:1.55}' +
  '.lmp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:14px;margin:0 0 28px;padding:0;list-style:none}' +
  '.lmp-card{border:1px solid #e6e6e6;border-radius:8px;padding:12px;display:flex;flex-direction:column;background:#fff}' +
  '.lmp-card img{width:100%;height:150px;object-fit:contain;margin-bottom:10px}' +
  '.lmp-card a.lmp-n{color:inherit;text-decoration:none;font-size:14px;line-height:1.35;flex:1}' +
  '.lmp-card a.lmp-n:hover{text-decoration:underline}' +
  '.lmp-p{font-weight:700;font-size:17px;margin-top:8px}' +
  '.lmp-a{font-size:13px;color:#2e7d32}.lmp-a.no{color:#999}' +
  '.lmp-h{font-size:20px;margin:24px 0 12px}' +
  '.lmp-links{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 20px;padding:0;list-style:none}' +
  '.lmp-links a{display:inline-block;padding:6px 10px;border:1px solid #ddd;border-radius:6px;text-decoration:none;color:inherit;font-size:14px}' +
  '.lmp-links a:hover{border-color:#999}' +
  '.lmp-brand{margin:0 0 18px}.lmp-brand h2{font-size:18px;margin:0 0 8px}' +
  '@media(max-width:600px){.lmp-grid{grid-template-columns:repeat(2,1fr);gap:8px}.lmp-card{padding:8px}.lmp-card img{height:110px}.lmp-p{font-size:15px}}' +
  '</style>';

function thumb(pic) {
  if (!pic) return '';
  return 'https://wsrv.nl/?url=' + encodeURIComponent(pic.replace(/^https?:\/\//, '')) + '&w=300&h=300&fit=contain&bg=white&output=webp';
}

function card(p, lang) {
  const t = T[lang];
  const name = lang === 'ru' ? p.name_ru : p.name_uk;
  const url = lang === 'ru' ? p.url_ru : p.url_uk;
  const img = p.picture
    ? `<a href="${esc(url)}"><img src="${esc(thumb(p.picture))}" alt="${esc(name)}" loading="lazy" width="300" height="300" onerror="this.onerror=null;this.src='${esc(p.picture)}'"></a>`
    : '';
  return `<li class="lmp-card">${img}<a class="lmp-n" href="${esc(url)}">${esc(name)}</a>` +
    (p.price ? `<div class="lmp-p">${p.price} ${t.uah}</div>` : '') +
    `<div class="lmp-a${p.available ? '' : ' no'}">${p.available ? t.inStock : t.outStock}</div></li>`;
}

function alternates(slug) {
  return { uk: SITE + pathFor('uk', slug), ru: SITE + pathFor('ru', slug) };
}

function renderModel(idx, products, slug, lang) {
  const t = T[lang];
  const m = idx.bySlug.get(slug);
  if (!m) return renderNotFound(lang, slug);
  const name = modelName(m);
  const tg = typeGen(m, lang);
  const full = (tg ? tg + ' ' : '') + name;
  const items = m.skus.map((s) => products.get(s)).filter(Boolean)
    .sort((a, b) => (b.available - a.available) || (a.price - b.price));
  const minPrice = Math.min(...items.map((p) => p.price).filter(Boolean)) || 0;
  let kinds = '';
  if (lang === 'uk') {
    const k = []; for (const p of items) { const x = p.kind_uk.toLowerCase(); if (x && !k.includes(x)) k.push(x); }
    kinds = k.slice(0, 4).join(', ');
  }
  // інші моделі того ж бренду — найбільше спільних товарів
  const mine = new Set(m.skus);
  const other = idx.list.filter((o) => o.slug !== slug && o.brand.toUpperCase() === m.brand.toUpperCase())
    .map((o) => ({ o, s: o.skus.filter((x) => mine.has(x)).length }))
    .sort((a, b) => b.s - a.s || b.o.skus.length - a.o.skus.length).slice(0, 24).map((x) => x.o);

  const h1 = t.parts + ' ' + full;
  const html = STYLE +
    `<p class="lmp-intro">${t.intro(esc(name), items.length)}</p>` +
    `<ul class="lmp-grid">${items.map((p) => card(p, lang)).join('')}</ul>` +
    (other.length ? `<h2 class="lmp-h">${esc(t.other(m.brand))}</h2><ul class="lmp-links">` +
      other.map((o) => `<li><a href="${pathFor(lang, o.slug)}">${esc(modelName(o))}</a></li>`).join('') + '</ul>' : '') +
    `<p><a href="${pathFor(lang)}">${t.all} →</a></p>`;

  const self = pathFor(lang, slug);
  const ld = [
    { '@context': 'https://schema.org', '@type': 'CollectionPage', name: h1, url: SITE + self, inLanguage: lang === 'ru' ? 'ru' : 'uk',
      mainEntity: { '@type': 'ItemList', numberOfItems: items.length,
        itemListElement: items.map((p, i) => ({ '@type': 'ListItem', position: i + 1, url: lang === 'ru' ? p.url_ru : p.url_uk, name: lang === 'ru' ? p.name_ru : p.name_uk })) } },
  ];
  return {
    status: 200,
    title: h1 + t.titleTail,
    description: t.desc(full, items.length, minPrice, kinds),
    h1, html, robots: 'index, follow',
    canonical: SITE + self, alternates: alternates(slug),
    ...crumbsOut(crumbs(lang, [{ name: t.home }, { name: t.hub, url: pathFor(lang) }, { name: name, self }])),
    jsonld: ld,
  };
}

function renderHub(idx, lang) {
  const t = T[lang];
  const byBrand = new Map();
  for (const m of idx.list) {
    const k = m.brand.toUpperCase();
    if (!byBrand.has(k)) byBrand.set(k, { brand: m.brand, list: [] });
    byBrand.get(k).list.push(m);
  }
  const brands = [...byBrand.values()].sort((a, b) => a.brand.localeCompare(b.brand));
  const html = STYLE +
    `<p class="lmp-intro">${t.hubIntro}</p>` +
    `<ul class="lmp-links">${brands.map((b) => `<li><a href="#b-${slugPart(b.brand)}">${esc(b.brand)} (${b.list.length})</a></li>`).join('')}</ul>` +
    brands.map((b) => `<div class="lmp-brand" id="b-${slugPart(b.brand)}"><h2>${esc(b.brand)}</h2><ul class="lmp-links">` +
      b.list.slice().sort((x, y) => x.model.localeCompare(y.model))
        .map((m) => `<li><a href="${pathFor(lang, m.slug)}">${esc(m.model)}</a></li>`).join('') + '</ul></div>').join('');
  const self = pathFor(lang);
  return {
    status: 200,
    title: t.hub + t.titleTail,
    description: t.hubDesc,
    h1: t.hub, html, robots: 'index, follow',
    canonical: SITE + self, alternates: alternates(''),
    ...crumbsOut(crumbs(lang, [{ name: t.home }, { name: t.hub, self }])),
    jsonld: [],
  };
}

function renderNotFound(lang, slug) {
  const t = T[lang];
  return {
    status: 404,
    title: t.notFound + ' | LARTEK',
    description: '',
    h1: t.notFound,
    html: `<p>${t.notFoundText}</p><p><a href="${pathFor(lang)}">${t.all} →</a></p>`,
    robots: 'noindex, follow',
    canonical: SITE + pathFor(lang, slug), alternates: alternates(slug),
    ...crumbsOut(crumbs(lang, [{ name: t.home }, { name: t.hub, url: pathFor(lang) }, { name: t.notFound, self: pathFor(lang, slug) }])),
    jsonld: [],
  };
}

function renderSitemap(idx) {
  const urls = [''].concat(idx.list.map((m) => m.slug));
  const body = urls.map((s) => {
    const a = alternates(s);
    const alt = `<xhtml:link rel="alternate" hreflang="uk" href="${a.uk}"/><xhtml:link rel="alternate" hreflang="ru" href="${a.ru}"/>`;
    return `<url><loc>${a.uk}</loc>${alt}</url><url><loc>${a.ru}</loc>${alt}</url>`;
  }).join('\n');
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n' + body + '\n</urlset>';
}

// ── Завантаження з кешем (раз на 6 год; при помилці лишаємо старий індекс) ──
const MODELS_SQL = `
  SELECT mode() WITHIN GROUP (ORDER BY brand) AS brand,
         mode() WITHIN GROUP (ORDER BY model) AS model,
         model_norm,
         array_agg(DISTINCT sku) AS skus
    FROM compatibility
   WHERE brand <> '' AND length(model_norm) >= 3
   GROUP BY upper(brand), model_norm
  HAVING count(DISTINCT sku) >= $1
   ORDER BY count(DISTINCT sku) DESC
   LIMIT $2`;

let state = { at: 0, idx: null, products: null, loading: null };

async function fetchFeed() {
  const r = await fetch(RU_FEED, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LartekModelPages/1.0)', Accept: 'application/xml,text/xml,*/*' } });
  if (!r.ok) throw new Error('фід недоступний (HTTP ' + r.status + ')');
  return r.text();
}

async function load(pool) {
  if (state.idx && Date.now() - state.at < TTL_MS) return state;
  if (state.loading) return state.idx ? state : state.loading;
  state.loading = (async () => {
    try {
      const [xml, db] = await Promise.all([fetchFeed(), pool.query(MODELS_SQL, [MIN_PRODUCTS, LIMIT * 4])]);
      const products = parseFeed(xml);
      const idx = buildIndex(db.rows, products);
      state = { at: Date.now(), idx, products, loading: null };
    } catch (e) {
      console.error('model-pages load:', e.message);
      state.loading = null;
      if (!state.idx) throw e;
    }
    return state;
  })();
  return state.idx ? state : state.loading;
}

function register(app, pool) {
  const lang = (req) => (req.query.lang === 'ru' ? 'ru' : 'uk');
  app.get('/model-pages/page', async (req, res) => {
    try {
      const s = await load(pool);
      const slug = String(req.query.slug || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
      const out = slug ? renderModel(s.idx, s.products, slug, lang(req)) : renderHub(s.idx, lang(req));
      res.set('Cache-Control', 'public, max-age=1800');
      res.json(out);
    } catch (e) {
      console.error(e);
      res.status(503).json({ error: 'unavailable' });
    }
  });
  app.get('/model-pages/sitemap.xml', async (req, res) => {
    try {
      const s = await load(pool);
      res.set('Content-Type', 'application/xml; charset=utf-8');
      res.set('Cache-Control', 'public, max-age=3600');
      res.send(renderSitemap(s.idx));
    } catch (e) {
      console.error(e);
      res.status(503).send('unavailable');
    }
  });
  app.get('/model-pages/stats', async (req, res) => {
    try {
      const s = await load(pool);
      res.json({ pages: s.idx.list.length, products: s.products.size, builtAt: new Date(s.at).toISOString(),
        top: s.idx.list.slice(0, 20).map((m) => ({ slug: m.slug, n: m.skus.length, type: typeGen(m, 'uk') })) });
    } catch (e) {
      res.status(503).json({ error: e.message });
    }
  });
}

module.exports = { register, parseFeed, buildIndex, renderModel, renderHub, renderSitemap, makeSlug, plural };
