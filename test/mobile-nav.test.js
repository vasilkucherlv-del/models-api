// Тест збирання /mobile-nav.js і вимикача MOBILE_NAV.
//   node test/mobile-nav.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { parseParts, buildMobileNav } = require('../mobile-nav-build');

const html = fs.readFileSync(path.join(__dirname, '..', 'embed', 'mobile-nav.html'), 'utf8');

assert.deepStrictEqual(parseParts(''), ['search', 'buy', 'bar']);
assert.deepStrictEqual(parseParts(undefined), ['search', 'buy', 'bar']);
assert.deepStrictEqual(parseParts('off'), []);
assert.deepStrictEqual(parseParts('OFF'), []);
assert.deepStrictEqual(parseParts('search, bar'), ['search', 'bar']);
assert.deepStrictEqual(parseParts('foo'), []);

// off → порожній скрипт без коду віджета
const off = buildMobileNav(html, 'off');
assert.ok(!/mnav-bar/.test(off), 'off: коду віджета не має бути');

// повна збірка — валідний JS, PARTS підставлено
const full = buildMobileNav(html, '');
new vm.Script(full);
assert.ok(full.includes('var PARTS = "search,buy,bar";'));
assert.ok(full.includes('.mnav-bar{'), 'CSS вбудовано');

// часткова — лише вибрані частини
const part = buildMobileNav(html, 'search,buy');
new vm.Script(part);
assert.ok(part.includes('var PARTS = "search,buy";'));

console.log('mobile-nav: OK');
