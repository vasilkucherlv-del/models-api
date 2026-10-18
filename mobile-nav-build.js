// Збирає /mobile-nav.js з embed/mobile-nav.html з урахуванням вимикача MOBILE_NAV.
//   MOBILE_NAV порожня       → усі частини (search,buy,bar)
//   MOBILE_NAV=off           → порожній скрипт (швидкий відкат без правок у Horoshop)
//   MOBILE_NAV=search,bar    → лише перелічені частини
const PARTS = ['search', 'buy', 'bar'];

function parseParts(env) {
  const v = String(env || '').trim().toLowerCase();
  if (!v) return PARTS.slice();
  if (v === 'off' || v === '0' || v === 'none') return [];
  return v.split(/[\s,;]+/).filter(p => PARTS.includes(p));
}

function buildMobileNav(html, env) {
  const parts = parseParts(env);
  if (!parts.length) return '/* mobile-nav: вимкнено (MOBILE_NAV) */\n';
  const css = (html.match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1];
  const js = (html.match(/<script>([\s\S]*?)<\/script>/) || [, ''])[1];
  return '(function(){var st=document.createElement("style");st.textContent=' + JSON.stringify(css) + ';document.head.appendChild(st);})();\n'
    + js.replace("var PARTS = 'search,buy,bar';", 'var PARTS = ' + JSON.stringify(parts.join(',')) + ';');
}

module.exports = { parseParts, buildMobileNav, PARTS };
