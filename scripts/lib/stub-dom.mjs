/**
 * A DOM and a Sauce `common` small enough to boot pages/src/announcer.mjs in
 * Node, and honest enough that booting it means something.
 *
 * Two rules shape the stubs:
 *
 *   - Every element lookup returns a LIVE element, never null. A stub that
 *     returned null would let the module's `if (el)` guards skip the very code
 *     paths these tests exist to run.
 *   - settingsStore really dispatches `changed` and `set`. Both windows hang
 *     substantial behaviour off those listeners -- the overlay re-renders its
 *     status dots, background and history from them -- and a no-op
 *     addEventListener would leave all of it unexecuted.
 *
 * Nothing here tries to be a browser. It is the smallest surface on which the
 * mod's own code runs unmodified.
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

export const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------
let failures = 0;

export function check(name, ok, detail = '') {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
    if (!ok) failures++;
    return ok;
}

export function section(title) {
    console.log(`\n=== ${title} ===`);
}

export function finish() {
    console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
    process.exit(failures ? 1 : 0);
}

/**
 * A boot failure makes every later check meaningless -- and worse, several
 * would "pass" trivially, because nothing ran to change anything. Say so and
 * stop rather than printing a reassuring wall of green.
 */
export function bailOnBootFailure(err) {
    if (!err) return;
    console.log('\nThe window did not boot, so nothing below could mean anything. Stopping.');
    console.log(err.stack || String(err));
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------
/** Every listener any element registers, so a test can fire one. */
export const listeners = [];

export function makeEl(tag = 'div', data = {}) {
    const el = {
        tagName: String(tag).toUpperCase(),
        className: '', title: '', label: '',
        value: '', hidden: false, disabled: false, checked: false, href: '', type: '',
        dataset: { ...data },
        style: { setProperty() {}, removeProperty() {}, getPropertyValue: () => '' },
        children: [], options: [], _classes: new Set(),
        addEventListener: (t, fn) => listeners.push({ el, t, fn }),
        removeEventListener: () => {},
        append: (...c) => el.children.push(...c),
        appendChild: c => { el.children.push(c); return c; },
        insertBefore: c => { el.children.unshift(c); return c; },
        remove: () => {},
        setAttribute: (k, v) => { el[k] = v; },
        getAttribute: k => el[k] ?? null,
        hasAttribute: k => el[k] != null,
        removeAttribute: k => { delete el[k]; },
        closest: () => el,
        querySelector: () => makeEl(),
        querySelectorAll: () => [],
        focus() {}, blur() {}, click() {}, scrollIntoView() {},
        insertAdjacentHTML() {},
        getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }),
        classList: {
            add: (...c) => c.forEach(x => el._classes.add(x)),
            remove: (...c) => c.forEach(x => el._classes.delete(x)),
            contains: c => el._classes.has(c),
            toggle: (c, on) => { on ? el._classes.add(c) : el._classes.delete(c); return !!on; }
        }
    };

    // textContent and innerHTML REPLACE an element's contents. `el.textContent
    // = ''` is the ordinary way to empty a container, and a plain field would
    // let a rebuild silently append instead -- so a test would pass while the
    // real page grew duplicate options on every render.
    let text = '';
    let html = '';
    Object.defineProperty(el, 'textContent', {
        // Reading composes from descendants, as a real one does. Assigning
        // clears them, so own-text and children are never both in play --
        // without this a node built from appended spans reads as empty, and a
        // test asserting on rendered text silently checks nothing.
        get: () => (el.children.length
            ? el.children.map(c => c?.textContent ?? '').join('')
            : text),
        set: v => { text = String(v); html = ''; el.children.length = 0; },
        enumerable: true
    });
    Object.defineProperty(el, 'innerHTML', {
        get: () => html,
        set: v => { html = String(v); text = ''; el.children.length = 0; },
        enumerable: true
    });
    return el;
}

/** Fire the handler a test cares about, e.g. fire(sel, 'change'). */
export function fire(el, type) {
    const found = listeners.filter(l => l.el === el && l.t === type);
    for (const l of found) {
        // currentTarget as well as target: a handler bound directly to an
        // element reads currentTarget, and leaving it undefined would throw
        // only in the test, which is the wrong place for a difference.
        l.fn({ target: el, currentTarget: el, preventDefault() {}, stopPropagation() {} });
    }
    return found.length;
}

export const hidden = el => el._classes.has('hidden');

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------
const byId = new Map();
export const el = id => {
    if (!byId.has(id)) byId.set(id, makeEl('div'));
    return byId.get(id);
};

/**
 * @param {object[]} providerRows elements returned for `[data-provider]`, the
 *   selector whose visibility pass is the thing most worth asserting on.
 */
export function installGlobals({ providerRows = [] } = {}) {
    globalThis.document = {
        readyState: 'complete',
        body: makeEl('body'),
        documentElement: makeEl('html'),
        getElementById: el,
        querySelector: sel => el(`sel:${sel}`),
        querySelectorAll: sel => (sel === '[data-provider]' ? providerRows : []),
        createElement: makeEl,
        createTextNode: t => ({ textContent: t }),
        addEventListener: () => {}
    };
    globalThis.window = { open: () => {}, addEventListener: () => {}, location: { href: '' } };
    Object.defineProperty(globalThis, 'navigator', {
        value: { clipboard: { writeText: async () => {} } }, configurable: true
    });
    // Two voices, not none. populateVoicePicker() waits up to 3s for
    // `voiceschanged` when getVoices() comes back empty -- correct in a browser,
    // where the list arrives late, but with an empty stub every boot paid the
    // full 3 seconds. It also means the picker and pickVoice() actually run.
    const voice = (name, lang, def = false) => ({ name, lang, default: def, localService: true });
    globalThis.speechSynthesis = {
        getVoices: () => [voice('Daniel', 'en-GB', true), voice('Samantha', 'en-US')],
        cancel: () => {}, speak: () => {}, addEventListener: () => {}
    };
    globalThis.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
    // Empty, but present: migrateLegacySettings() scans raw localStorage, and
    // without this it takes its catch branch and is never exercised at all.
    globalThis.localStorage = { length: 0, key: () => null, getItem: () => null, setItem: () => {} };
    // Offline on purpose. A test that quietly made real calls to Anthropic or
    // to the hosted service would be worse than no test.
    globalThis.fetch = async () => { throw new Error('no network in this test'); };
}

// ---------------------------------------------------------------------------
// The module under test
// ---------------------------------------------------------------------------
const COMMON_STUB = `
const store = new Map();
const subs = { changed: [], set: [] };
function emit(type, data) { for (const fn of subs[type] || []) fn({ data }); }
export const settingsStore = {
    get: k => store.get(k),
    set: (k, v) => {
        // set(null, bag) replaces the whole bag; migrateLegacySettings uses it.
        if (k === null) { for (const [a, b] of Object.entries(v || {})) store.set(a, b); }
        else { store.set(k, v); }
        emit('set', { key: k, value: v });
        emit('changed', { changed: new Set(k === null ? Object.keys(v || {}) : [k]) });
    },
    remove: k => { store.delete(k); },
    setDefault: obj => { for (const [k, v] of Object.entries(obj)) if (!store.has(k)) store.set(k, v); },
    addEventListener: (type, fn) => { (subs[type] ||= []).push(fn); }
};
export function initInteractionListeners() {}
export function initSettingsForm() { return async () => {}; }
export function initNationFlags() {}
export const rpc = new Proxy({}, { get: () => async () => ({}) });
export const subscribed = new Map();
export const subscribe = (name, fn) => { subscribed.set(name, fn); };
`;

/**
 * Load announcer.mjs with its imports pointed at real file paths: the Sauce one
 * is an absolute URL only the Electron host serves, and the relative ones would
 * not resolve from the temp directory the copy under test lives in.
 *
 * UNDER_TEST points at a different copy -- useful for confirming a regression
 * against an older revision.
 */
export async function loadAnnouncer() {
    const tmp = mkdtempSync(join(tmpdir(), 'lunatic-boot-'));
    writeFileSync(join(tmp, 'common-stub.mjs'), COMMON_STUB);

    const src = readFileSync(process.env.UNDER_TEST || join(REPO, 'pages/src/announcer.mjs'), 'utf8')
        .replace("'/pages/src/common.mjs'", JSON.stringify(pathToFileURL(join(tmp, 'common-stub.mjs')).href))
        // Every sibling leaf module, not a named list: the copy under test lives
        // in a temp directory, so any './x.mjs' would fail to resolve there.
        .replace(/'\.\/([\w-]+\.mjs)'/g,
            (_, f) => JSON.stringify(pathToFileURL(join(REPO, 'pages/src', f)).href));
    writeFileSync(join(tmp, 'announcer.mjs'), src);

    const mod = await import(pathToFileURL(join(tmp, 'announcer.mjs')).href);
    const common = await import(pathToFileURL(join(tmp, 'common-stub.mjs')).href);
    return { mod, common };
}
