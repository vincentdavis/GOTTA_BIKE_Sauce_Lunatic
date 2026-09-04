#!/usr/bin/env node
/**
 * Boot the settings window against a stub DOM.
 *
 * The mod has no build step and no test framework, so nothing ever EXECUTED
 * pages/src/announcer.mjs before a rider opened the settings window. That is
 * how v0.4.0 shipped with `renderConnection()` and its sign-out handler sitting
 * in setupProviderControls(), which does not declare the elements they close
 * over: the function threw `ReferenceError: signOutBtn is not defined` on its
 * first statement, so the [data-provider] visibility pass never ran and EVERY
 * provider's fields stayed on screen at once -- including the Anthropic API key
 * field, under a provider that has no key.
 *
 * `node --check` cannot see that; it is a runtime error in a function that only
 * runs in a browser. This does the cheapest possible thing that would have
 * caught it: hand the module a DOM where every lookup returns a live element,
 * call the real settings entry point, and assert the rows it is supposed to
 * hide are hidden.
 *
 *   node scripts/settings-boot-test.mjs
 *
 * Set UNDER_TEST=<path> to point it at a different copy of announcer.mjs --
 * useful for confirming a regression against an older revision.
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const TMP = mkdtempSync(join(tmpdir(), 'lunatic-boot-'));

let bad = 0;
const check = (n, ok, d = '') => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`);
    if (!ok) bad++;
};

// ---------------------------------------------------------------------------
// The stub DOM
// ---------------------------------------------------------------------------
// Every lookup returns a live element on purpose. A stub that returned null
// would let `if (el)` guards skip the very code paths this is here to run.

const listeners = [];

function makeEl(tag = 'div', data = {}) {
    const el = {
        tagName: tag.toUpperCase(), textContent: '', innerHTML: '', className: '',
        value: '', hidden: false, disabled: false, checked: false, href: '',
        dataset: { ...data }, style: {}, children: [], options: [], _classes: new Set(),
        addEventListener: (t, fn) => listeners.push({ el, t, fn }),
        removeEventListener: () => {},
        append: (...c) => el.children.push(...c),
        appendChild: c => { el.children.push(c); return c; },
        remove: () => {},
        setAttribute: (k, v) => { el[k] = v; },
        getAttribute: k => el[k] ?? null,
        hasAttribute: k => el[k] != null,
        removeAttribute: k => { delete el[k]; },
        closest: () => el,
        querySelector: () => makeEl(),
        querySelectorAll: () => [],
        focus: () => {}, click: () => {}, scrollIntoView: () => {},
        insertAdjacentHTML: () => {},
        classList: {
            add: c => el._classes.add(c),
            remove: c => el._classes.delete(c),
            contains: c => el._classes.has(c),
            toggle: (c, on) => { on ? el._classes.add(c) : el._classes.delete(c); return on; }
        }
    };
    return el;
}

// The rows the visibility pass is meant to show or hide. The last one is
// shared by two providers, which is how the Test Connection button is marked.
const rows = {
    anthropic: makeEl('div', { provider: 'anthropic' }),
    compatible: makeEl('div', { provider: 'compatible' }),
    hosted: makeEl('div', { provider: 'hosted' }),
    shared: makeEl('button', { provider: 'anthropic compatible' })
};

const byId = new Map();
const idEl = id => {
    if (!byId.has(id)) byId.set(id, makeEl('div'));
    return byId.get(id);
};

globalThis.document = {
    readyState: 'complete',
    body: makeEl('body'),
    documentElement: makeEl('html'),
    getElementById: idEl,
    querySelector: sel => idEl(`sel:${sel}`),
    querySelectorAll: sel => (sel === '[data-provider]' ? Object.values(rows) : []),
    createElement: makeEl,
    createTextNode: t => ({ textContent: t }),
    addEventListener: () => {}
};
globalThis.window = { open: () => {}, addEventListener: () => {}, location: { href: '' } };
Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: async () => {} } }, configurable: true
});
globalThis.speechSynthesis = {
    getVoices: () => [], cancel: () => {}, speak: () => {}, addEventListener: () => {}
};
globalThis.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
// Empty, but present: migrateLegacySettings() scans raw localStorage, and
// without this it takes its catch branch and is never exercised at all.
globalThis.localStorage = { length: 0, key: () => null, getItem: () => null, setItem: () => {} };
// Offline: nothing here should need the network, and a test that quietly made
// real calls to the hosted service would be worse than no test.
globalThis.fetch = async () => { throw new Error('no network in this test'); };

// ---------------------------------------------------------------------------
// The stub Sauce `common`
// ---------------------------------------------------------------------------
const TOKEN_KEY = '/gotta-bike-lunatic-device-token';
writeFileSync(join(TMP, 'common-stub.mjs'), `
const store = new Map();
export const settingsStore = {
    get: k => store.get(k),
    set: (k, v) => { store.set(k, v); },
    remove: k => store.delete(k),
    setDefault: obj => { for (const [k, v] of Object.entries(obj)) if (!store.has(k)) store.set(k, v); },
    addEventListener: () => {}
};
export function initInteractionListeners() {}
export function initSettingsForm() { return async () => {}; }
export function initNationFlags() {}
export const rpc = new Proxy({}, { get: () => async () => ({}) });
export const subscribe = () => {};
`);

// The module under test, with its two imports pointed at real file paths: the
// Sauce one is an absolute URL only the Electron host serves, and the relative
// one would not resolve from a temp directory.
const src = readFileSync(process.env.UNDER_TEST || join(REPO, 'pages/src/announcer.mjs'), 'utf8')
    .replace("'/pages/src/common.mjs'", JSON.stringify(pathToFileURL(join(TMP, 'common-stub.mjs')).href))
    .replace("'./providers.mjs'", JSON.stringify(pathToFileURL(join(REPO, 'pages/src/providers.mjs')).href));
writeFileSync(join(TMP, 'announcer.mjs'), src);

const mod = await import(pathToFileURL(join(TMP, 'announcer.mjs')).href);
const { settingsStore } = await import(pathToFileURL(join(TMP, 'common-stub.mjs')).href);

// ---------------------------------------------------------------------------

console.log('\n=== the settings window boots at all ===');
let bootErr = null;
try {
    await mod.lunaticAnnouncerSettingsMain();
} catch (err) {
    bootErr = err;
}
check('lunaticAnnouncerSettingsMain() runs to completion', !bootErr,
    bootErr ? `${bootErr.constructor.name}: ${bootErr.message}` : '');

// A boot failure makes every check below meaningless — and several would
// "pass" trivially, because nothing ran to hide anything. Say so and stop.
if (bootErr) {
    console.log('\nboot failed, so the checks below cannot mean anything. Stopping.');
    process.exit(1);
}

console.log('\n=== the provider visibility pass ran ===');
const hidden = el => el._classes.has('hidden');
check('anthropic rows shown', !hidden(rows.anthropic));
check('compatible rows hidden', hidden(rows.compatible));
check('hosted rows hidden', hidden(rows.hosted));
check('a row owned by two providers is shown', !hidden(rows.shared));

console.log('\n=== changing provider re-runs it ===');
const providerSel = document.querySelector('select[name="aiProvider"]');
providerSel.value = 'hosted';
const onChange = listeners.find(l => l.el === providerSel && l.t === 'change');
check('the provider select has a change handler', !!onChange);
let switchErr = null;
try { onChange?.fn(); } catch (err) { switchErr = err; }
check('switching provider does not throw', !switchErr,
    switchErr ? `${switchErr.constructor.name}: ${switchErr.message}` : '');
check('the API key row is hidden under a provider that has no key', hidden(rows.anthropic));
check('hosted rows shown', !hidden(rows.hosted));
check('the shared row is hidden too', hidden(rows.shared));

console.log('\n=== the connection row tracks the stored token ===');
const badge = document.getElementById('hosted-conn-badge');
check('no token reads as Not connected', badge.textContent === 'Not connected', badge.textContent);
settingsStore.set(TOKEN_KEY, 'anon-token');
onChange?.fn();
check('an anonymous token reads as Anonymous', badge.textContent === 'Anonymous', badge.textContent);

const signOut = document.getElementById('hosted-signout-btn');
const onSignOut = listeners.find(l => l.el === signOut && l.t === 'click');
check('sign-out is wired', !!onSignOut);
let outErr = null;
try { onSignOut?.fn(); } catch (err) { outErr = err; }
check('sign-out does not throw', !outErr, outErr ? `${outErr.constructor.name}: ${outErr.message}` : '');
check('sign-out clears the token', !settingsStore.get(TOKEN_KEY));
check('sign-out updates the badge', badge.textContent === 'Not connected', badge.textContent);

console.log(bad ? `\n${bad} FAILURE(S)` : '\nall checks passed');
process.exit(bad ? 1 : 0);
