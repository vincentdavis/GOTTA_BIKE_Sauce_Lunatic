#!/usr/bin/env node
/**
 * Boot the SETTINGS window against a stub DOM.
 *
 * The mod has no build step and no test framework, so nothing ever EXECUTED
 * pages/src/announcer.mjs before a rider opened a window. That is how v0.4.0
 * shipped with renderConnection() and its sign-out handler sitting in
 * setupProviderControls(), which does not declare the elements they close over:
 * the function threw `ReferenceError: signOutBtn is not defined` on its first
 * statement, so the [data-provider] visibility pass never ran and EVERY
 * provider's fields stayed on screen at once -- including the Anthropic API key
 * field, under a provider that has no key.
 *
 * `node --check` cannot see that; it is a runtime error in a function that only
 * runs in a browser. This does the cheapest thing that would have caught it.
 *
 *   node scripts/settings-boot-test.mjs
 */
import {
    installGlobals, loadAnnouncer, makeEl, el, fire, hidden,
    check, section, finish, bailOnBootFailure
} from './lib/stub-dom.mjs';

const TOKEN_KEY = '/gotta-bike-lunatic-device-token';

// The rows the visibility pass is meant to show or hide. The last is shared by
// two providers, which is how the Test Connection button is marked.
const rows = {
    anthropic: makeEl('div', { provider: 'anthropic' }),
    compatible: makeEl('div', { provider: 'compatible' }),
    hosted: makeEl('div', { provider: 'hosted' }),
    shared: makeEl('button', { provider: 'anthropic compatible' })
};

installGlobals({ providerRows: Object.values(rows) });
const { mod, common: { settingsStore } } = await loadAnnouncer();

section('the settings window boots at all');
let bootErr = null;
try {
    await mod.lunaticAnnouncerSettingsMain();
} catch (err) {
    bootErr = err;
}
check('lunaticAnnouncerSettingsMain() runs to completion', !bootErr,
    bootErr ? `${bootErr.constructor.name}: ${bootErr.message}` : '');
bailOnBootFailure(bootErr);

section('the provider visibility pass ran');
check('anthropic rows shown', !hidden(rows.anthropic));
check('compatible rows hidden', hidden(rows.compatible));
check('hosted rows hidden', hidden(rows.hosted));
check('a row owned by two providers is shown', !hidden(rows.shared));

section('changing provider re-runs it');
const providerSel = document.querySelector('select[name="aiProvider"]');
providerSel.value = 'hosted';
check('the provider select has a change handler', fire(providerSel, 'change') === 1);
check('the API key row is hidden under a provider that has no key', hidden(rows.anthropic));
check('hosted rows shown', !hidden(rows.hosted));
check('the shared row is hidden too', hidden(rows.shared));

section('the connection row tracks the stored token');
const badge = el('hosted-conn-badge');
check('no token reads as Not connected', badge.textContent === 'Not connected', badge.textContent);
settingsStore.set(TOKEN_KEY, 'anon-token');
fire(providerSel, 'change');
check('an anonymous token reads as Anonymous', badge.textContent === 'Anonymous', badge.textContent);
check('the badge class follows the state', badge.className === 'conn-badge anon', badge.className);

section('the voice picker is built from the shared prompt table');
const picker = el('style-preset');
const voices = picker.children.map(o => o.value);
check('every built-in is offered', ['tour', 'lunatic', 'domestique', 'tactical']
    .every(id => voices.includes(id)), voices.join(', '));
check('plus the custom slot', voices[voices.length - 1] === 'custom');
check('each option is labelled', picker.children.every(o => o.textContent.includes('—')));

section('the voice picker resolves without waiting out its timeout');
const ttsSel = el('tts-voice');
check('voices are listed', ttsSel.children.length === 2, `${ttsSel.children.length} option(s)`);
check('one is selected', !!ttsSel.value, ttsSel.value);

section('sign-out');
const fired = fire(el('hosted-signout-btn'), 'click');
check('sign-out is wired', fired === 1);
check('sign-out clears the token', !settingsStore.get(TOKEN_KEY));
check('sign-out updates the badge', badge.textContent === 'Not connected', badge.textContent);

finish();
