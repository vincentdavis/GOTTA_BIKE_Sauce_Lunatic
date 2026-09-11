/**
 * Browser-side stand-in for Sauce4Zwift's /pages/src/common.mjs, served by
 * scripts/settings-shots.mjs so the settings window can run its REAL code in a
 * real Chromium. The Node stub (stub-dom.mjs) proves the code executes; this
 * one lets you look at it.
 *
 * Functional where it matters: settingsStore dispatches `changed`/`set`, and
 * initSettingsForm binds every [name] control the way Sauce's does. Seed it by
 * setting window.__SEED before the page's module runs (the shooter does this
 * with addInitScript).
 */
const store = new Map();
const listeners = { changed: [], set: [] };
const emit = (t, data) => listeners[t].forEach(fn => fn({ data }));

for (const [k, v] of Object.entries(window.__SEED || {})) store.set(k, v);

export const settingsStore = {
    get: k => store.get(k),
    set: (k, v) => {
        if (k === null) { for (const [a, b] of Object.entries(v || {})) store.set(a, b); }
        else store.set(k, v);
        emit('set', { key: k, value: v });
        emit('changed', { changed: new Set(k === null ? Object.keys(v || {}) : [k]) });
    },
    remove: k => store.delete(k),
    setDefault: obj => { for (const [k, v] of Object.entries(obj)) if (!store.has(k)) store.set(k, v); },
    addEventListener: (t, fn) => { (listeners[t] ||= []).push(fn); },
    _dump: () => Object.fromEntries(store)
};
window.__store = settingsStore;

export function initInteractionListeners() {}
export function initNationFlags() {}
export const rpc = new Proxy({}, { get: () => async () => ({}) });
export const subscribe = () => {};
export const getRoute = async () => null;
export const getEventSubgroup = async () => null;

export function initSettingsForm(selector) {
    return async () => {
        const form = document.querySelector(selector);
        if (!form) return;
        for (const el of form.querySelectorAll('[name]')) {
            const name = el.name;
            const cur = store.get(name);
            if (el.type === 'checkbox') el.checked = !!cur;
            else if (cur !== undefined && cur !== null) el.value = String(cur);
            el.addEventListener('change', () => {
                let v = el.type === 'checkbox' ? el.checked : el.value;
                if (el.type === 'number' || el.type === 'range') v = Number(v);
                settingsStore.set(name, v);
            });
        }
    };
}
