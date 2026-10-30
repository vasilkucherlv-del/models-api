// Cloudflare Worker: сторінки «Запчастини для <модель>» на lartek.com.ua/modeli/ і /ru/modeli/.
//
// Маршрути Worker'а: lartek.com.ua/modeli*  і  lartek.com.ua/ru/modeli*
// Змінні (Settings → Variables): BOT_KEY — значення секретного заголовка x-lartek-bot (Secret, необов'язково).
//
// Як працює: бере звичайну текстову сторінку Horoshop як шаблон (меню, кошик, футер,
// мобільна/десктопна версія — рідні, за кукою покупця), а вміст (title, опис, H1,
// хлібні крихти, список товарів, розмітку) підставляє з models-api.

const API = 'https://models-api-production-4d71.up.railway.app';
const ORIGIN = 'https://lartek.com.ua';
const TPL = 'obmin-ta-povernennya';           // текстова сторінка-шаблон (UA: /TPL/, RU: /ru/TPL/)

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/(ru\/)?modeli(?:\/([^/]*))?(\/?)$/);
    if (!m) return fetch(req);
    const ru = !!m[1];
    const lang = ru ? 'ru' : 'uk';
    const slug = (m[2] || '').toLowerCase();

    // карта сайту
    if (slug === 'sitemap.xml') {
      const r = await fetch(API + '/model-pages/sitemap.xml', { cf: { cacheTtl: 3600, cacheEverything: true } });
      return new Response(r.body, { status: r.status, headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } });
    }
    // канонічна адреса — завжди зі слешем у кінці
    const clean = '/' + (ru ? 'ru/' : '') + 'modeli/' + (slug ? slug + '/' : '');
    if (url.pathname !== clean && !url.searchParams.has('v')) {
      return Response.redirect(ORIGIN + clean + url.search, 301);
    }

    const tplUrl = ORIGIN + '/' + (ru ? 'ru/' : '') + TPL + '/';
    const h = new Headers();
    for (const k of ['cookie', 'user-agent', 'accept', 'accept-language']) { const v = req.headers.get(k); if (v) h.set(k, v); }
    if (env.BOT_KEY) h.set('x-lartek-bot', env.BOT_KEY);

    // перемикач «Мобільна/Повна версія» (?v=…): Horoshop ставить куку і робить редирект — повертаємо покупця на цю ж сторінку
    if (url.searchParams.has('v')) {
      const r = await fetch(tplUrl + '?v=' + encodeURIComponent(url.searchParams.get('v')), { headers: h, redirect: 'manual' });
      const out = new Headers({ Location: ORIGIN + clean, 'Cache-Control': 'no-store' });
      for (const [k, v] of r.headers) if (k.toLowerCase() === 'set-cookie') out.append('Set-Cookie', v);
      return new Response(null, { status: 302, headers: out });
    }

    const [pr, tr] = await Promise.all([
      fetch(API + '/model-pages/page?lang=' + lang + '&slug=' + encodeURIComponent(slug), { cf: { cacheTtl: 1800, cacheEverything: true } }),
      fetch(tplUrl, { headers: h }),
    ]);
    if (!pr.ok || !tr.ok) return new Response('Сторінка тимчасово недоступна', { status: 503, headers: { 'Retry-After': '120' } });
    const p = await pr.json();

    const tplPaths = ['/' + TPL + '/', '/ru/' + TPL + '/'];
    const self = ORIGIN + clean;
    const alt = p.alternates || {};
    const setAttr = (attr, val) => ({ element(e) { e.setAttribute(attr, val); } });

    const rw = new HTMLRewriter()
      .on('title', { element(e) { e.setInnerContent(p.title); } })
      .on('meta[name="description"]', setAttr('content', p.description))
      .on('meta[name="robots"]', setAttr('content', p.robots))
      .on('link[rel="canonical"]', setAttr('href', p.canonical))
      .on('link[rel="alternate"][hreflang="uk"]', setAttr('href', alt.uk))
      .on('link[rel="alternate"][hreflang="ru"]', setAttr('href', alt.ru))
      .on('link[rel="alternate"][hreflang="x-default"]', setAttr('href', alt.uk))
      .on('meta[property="og:title"]', setAttr('content', p.h1))
      .on('meta[property="og:description"]', setAttr('content', p.description))
      .on('meta[property="og:url"]', setAttr('content', self))
      .on('head', { element(e) {
        for (const j of p.jsonld || []) e.append('<script type="application/ld+json">' + JSON.stringify(j).replace(/</g, '\\u003c') + '</script>', { html: true });
      } })
      // мобільний шаблон: h1.heading, .blog__inner > .text, крихти breadcrumbs__*; десктоп: h1.main-h, .page-content
      .on('h1', { element(e) { e.setInnerContent(p.h1); } })
      .on('.page-content', { element(e) { e.setInnerContent(p.html, { html: true }); } })                 // десктоп
      .on('.blog__inner > .text', { element(e) { e.setInnerContent(p.html, { html: true }); } })          // мобільний
      .on('.catalog__banners', { element(e) { e.remove(); } })
      // посилання на сторінку-шаблон (перемикач мови тощо) → на цю ж модель
      .on('a[href]', { element(e) {
        const href = (e.getAttribute('href') || '').replace(ORIGIN, '');
        for (const tp of tplPaths) {
          if (href === tp || href.startsWith(tp + '?')) e.setAttribute('href', (tp.startsWith('/ru/') ? alt.ru : alt.uk) + href.slice(tp.length));
        }
      } });

    const headers = new Headers(tr.headers);
    headers.delete('content-length');
    headers.set('Cache-Control', 'private, no-cache');
    headers.set('Content-Type', 'text/html; charset=utf-8');
    const first = rw.transform(new Response(tr.body, { status: p.status || 200, headers }));
    // Крихти: мобільний і десктопний шаблони мають різну розмітку — визначаємо за готовим HTML.
    const html = await first.text();
    const mobile = html.includes('breadcrumbs__list-wrap');
    return new HTMLRewriter().on('nav.breadcrumbs', { element(e) {
      e.setInnerContent(mobile ? p.breadcrumbs : p.breadcrumbs_desktop, { html: true });
    } }).transform(new Response(html, { status: p.status || 200, headers }));
  },
};
