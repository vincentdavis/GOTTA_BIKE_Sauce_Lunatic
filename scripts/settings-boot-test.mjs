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

section('the voice picker, and the library behind it');
const picker = el('style-preset');
const groups = () => picker.children.map(g => ({ label: g.label, values: g.children.map(o => o.value) }));

check('built-ins are grouped', groups()[0]?.label === 'Built-in', JSON.stringify(groups().map(g => g.label)));
check('all four are offered', ['tour', 'lunatic', 'domestique', 'tactical']
    .every(id => groups()[0]?.values.includes(id)), (groups()[0]?.values || []).join(', '));
check('there is no "custom" pseudo-voice any more', !groups().some(g => g.values.includes('custom')));
check('and no "Your prompts" group until you make one', groups().length === 1);

// The editor shows a built-in read-only, with no name field and no Save.
check('a built-in is read-only', el('custom-system-prompt').readOnly);
check('with no name field', el('prompt-name-row').hidden);
check('and no Save', el('prompt-save-btn').hidden);
check('but it does show the text', el('custom-system-prompt').value.includes('RULES'));

section('duplicate, edit, save — through the real buttons');
fire(el('prompt-duplicate-btn'), 'click');
check('a "Your prompts" group appears', groups().length === 2 && groups()[1].label === 'Your prompts',
    JSON.stringify(groups().map(g => g.label)));
check('and it is now the active voice', picker.value.startsWith('usr-'), picker.value);
check('the editor unlocked', !el('custom-system-prompt').readOnly);
check('the name field is shown', !el('prompt-name-row').hidden);
check('named after its source', el('prompt-name').value === 'Tour de France (copy)', el('prompt-name').value);
check('reset-to-source is offered', !el('prompt-revert-btn').hidden);

el('prompt-name').value = 'My race call';
el('custom-system-prompt').value = 'Shout everything, briefly.';
fire(el('prompt-save-btn'), 'click');
check('saving reports success', el('prompt-status').className === 'success', el('prompt-status').textContent);
check('the rename shows in the picker',
    groups()[1].values.length === 1 && picker.children[1].children[0].textContent === 'My race call',
    picker.children[1].children[0].textContent);

section('the editor refuses what the library refuses');
el('prompt-name').value = '';
fire(el('prompt-save-btn'), 'click');
check('an empty name is reported, not thrown', el('prompt-status').className === 'error',
    el('prompt-status').textContent);
el('prompt-name').value = 'My race call';

section('delete takes two clicks');
const del = el('prompt-delete-btn');
fire(del, 'click');
check('the first click arms it', del.textContent === 'Really delete?', del.textContent);
check('and says so', el('prompt-status').className === 'warn', el('prompt-status').textContent);
fire(el('custom-system-prompt'), 'input');
check('typing disarms it', del.textContent === 'Delete', del.textContent);
fire(del, 'click');
fire(del, 'click');
check('two clicks delete', groups().length === 1, JSON.stringify(groups().map(g => g.label)));
check('and fall back to a built-in', picker.value === 'tour', picker.value);

section('the update check does not get in the way');
// installGlobals() makes fetch throw, so this is the offline case: the settings
// window has to open regardless, and nothing may be left half-rendered.
check('the picker is still populated', groups()[0].values.includes('tour'));
check('no notice, because nothing was fetched', el('prompt-notice').hidden);
check('the off switch reflects the default', el('prompt-updates').value === 'auto',
    el('prompt-updates').value);

section('a pending notice is shown, and dismissible');
settingsStore.set('promptUpdateNotice', {
    updated: [{ id: 'lunatic', label: 'Lunatic', from: 1, to: 2 }],
    added: [{ id: 'velodrome', label: 'Velodrome' }]
});
settingsStore.set('builtinPrompts', { data: [], revision: 'x' });   // triggers a re-render
check('the notice appears', !el('prompt-notice').hidden);
check('naming both changes',
    /Lunatic/.test(el('prompt-notice-text').textContent) &&
    /Velodrome/.test(el('prompt-notice-text').textContent),
    el('prompt-notice-text').textContent);
check('and saying your own are safe', /unchanged/.test(el('prompt-notice-text').textContent));
fire(el('prompt-notice-dismiss'), 'click');
check('dismiss hides it', el('prompt-notice').hidden);
check('and it stays dismissed', settingsStore.get('promptUpdateNotice') === null);

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
