/**
 * Chooser logic tests.
 * They run the real compiled chooser module.
 * No vscode dependency and no GAP installation needed.
 *
 * Usage: node test/lib/help/chooser.test.js   (run npm run compile first)
 */

const path = require('path');
const { check, section, summary } = require('./helpers');

const OUT = path.join(__dirname, '..', '..', '..', 'out');
const {
    parseStyleValue,
    buildRenderStyleValue,
    buildChooserStyleValue,
    buildChooserShim,
} = require(path.join(OUT, 'help', 'webview', 'chooser.js'));

section('1. parseStyleValue');

const parseCases = [
    ['dark,toggless', { appearance: 'dark', extras: ['toggless'], hasDefault: false }, 'dark with extra'],
    ['toggless,times', { appearance: '', extras: ['toggless', 'times'], hasDefault: false }, 'extras only'],
    ['default', { appearance: '', extras: [], hasDefault: true }, 'reset'],
    ['light', { appearance: 'light', extras: [], hasDefault: false }, 'light only'],
    ['', { appearance: '', extras: [], hasDefault: false }, 'empty'],
    ['dark,lefttoc,ragged,times,nocolorprompt', { appearance: 'dark', extras: ['lefttoc', 'ragged', 'times', 'nocolorprompt'], hasDefault: false }, 'all options'],
];

for (const [value, expected, desc] of parseCases) {
    check(`parse [${desc}]`, expected, parseStyleValue(value));
}

section('2. Style value builders');

check('render value with resolved dark', 'dark,toggless', buildRenderStyleValue('dark', 'toggless'));
check('render value with no extras', 'light', buildRenderStyleValue('light', ''));
check('chooser value with explicit dark', 'dark,toggless', buildChooserStyleValue('dark', 'toggless'));
check('chooser value with system', '', buildChooserStyleValue('system', ''));
check('chooser value with extras only', 'toggless', buildChooserStyleValue('system', 'toggless'));

section('3. buildChooserShim');

const shim = buildChooserShim('chap1.html', 'dark,toggless');
check('shim seeds the cookie', true, shim.includes('GAPDocStyle="') && shim.includes('dark,toggless'));
check('shim sets the back target', true, shim.includes('"chap1.html"'));
check('shim overrides f', true, shim.includes('window.f ='));
check('shim overrides resetf', true, shim.includes('window.resetf'));
check('shim handles the reset event', true, shim.includes('addEventListener("reset"'));
check('no placeholder left', false, /STYLE_PLACEHOLDER|BACK_PLACEHOLDER/.test(shim));

const shimBadBack = buildChooserShim('a</script>b', 'x');
check('back target escaped', true, shimBadBack.includes('<\\/script'));

summary();
