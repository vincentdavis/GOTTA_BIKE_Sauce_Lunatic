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

// The tab strip, so first-run landing and tab memory can be driven.
const tabBtns = ['settings-tab', 'api-tab', 'prompts-tab', 'data-tab', 'help-tab']
    .map(id => makeEl('button', { tab: id }));
const tabPanels = tabBtns.map(b => { const p = makeEl('div'); p.id = b.dataset.tab; return p; });
const activeTab = () => tabBtns.find(b => b._classes.has('active'))?.dataset.tab;

installGlobals({ providerRows: Object.values(rows),
                 selectors: { '.tab-btn': tabBtns, '.tab-panel': tabPanels } });
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

section('F02: first run lands on the provider tab');
check('unconfigured, the window opens on AI Provider', activeTab() === 'api-tab', String(activeTab()));
check('and the Settings tab carries a nudge', el('setup-nudge').hidden === false);
fire(tabBtns[2], 'click');
check('clicking a tab activates it', activeTab() === 'prompts-tab', String(activeTab()));
check('and remembers it', settingsStore.get('settingsTab') === 'prompts-tab');

section('F03/F04: the status box before a key exists');
check('the status box is shown, not hidden', el('api-info').hidden === false);
check('and says what to do', /Not configured — pick Lunatic hosted/.test(el('api-status-text').textContent),
    el('api-status-text').textContent);
check('it is not tinted green', !el('api-info').className.includes('connected'), el('api-info').className);
check('the "No key?" hint shows on a keyed provider', el('no-key-hint').hidden === false);
fire(el('test-api-btn'), 'click');
check('testing with no key says what to paste', el('api-test-status').textContent === 'Paste your Anthropic API key first.',
    el('api-test-status').textContent);

section('F04: a saved key is "not tested", not "Connected"');
settingsStore.set('claudeApiKey', 'sk-ant-api03-not-a-real-key');
check('the box says saved, not tested', el('api-status-text').textContent === 'Key saved — not tested',
    el('api-status-text').textContent);
check('still not green', el('api-info').className === 'api-info untested', el('api-info').className);
check('the No key? hint goes away', el('no-key-hint').hidden === true);
check('so does the Settings nudge', el('setup-nudge').hidden === true);
check('no next-step until something actually connects', el('api-next-step').hidden === true);

// Only a successful REQUEST may turn the box green. Drive the real Test
// Connection handler with a stubbed fetch, then change a setting.
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); };
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), headers: { get: () => null } });
fire(el('test-api-btn'), 'click');
await settle();
check('a passing test turns the box green', el('api-info').className === 'api-info connected',
    el('api-info').className);
check('and says Connected', el('api-status-text').textContent === 'Connected');
check('the inline result agrees', el('api-test-status').className === 'success', el('api-test-status').textContent);
check('and the next step appears', el('api-next-step').hidden === false &&
    /Close this window and ride/.test(el('api-next-step').textContent), el('api-next-step').textContent);
check('mentioning speech is off, because it is', /Speech is off/.test(el('api-next-step').textContent));

settingsStore.set('claudeModel', 'claude-sonnet-5');
check('changing a setting downgrades the box', el('api-info').className === 'api-info stale',
    el('api-info').className);
check('to "changed since the last test"', /changed since the last test/.test(el('api-status-text').textContent),
    el('api-status-text').textContent);
check('and clears the stale "Connection successful!"', el('api-test-status').textContent === '',
    JSON.stringify(el('api-test-status').textContent));
check('the next step is withdrawn', el('api-next-step').hidden === true);

globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'invalid x-api-key' } }),
    headers: { get: () => null } });
fire(el('test-api-btn'), 'click');
await settle();
check('a failing test turns the box red', el('api-info').className === 'api-info failed', el('api-info').className);
check('and says so', /Test failed/.test(el('api-status-text').textContent), el('api-status-text').textContent);
globalThis.fetch = async () => { throw new Error('no network in this test'); };

settingsStore.set('claudeApiKey', '');
check('clearing the key returns to Not configured',
    /Not configured/.test(el('api-status-text').textContent), el('api-status-text').textContent);
settingsStore.set('claudeApiKey', 'sk-ant-api03-not-a-real-key');

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

section('the Help tab links to the help page');
{
    const link = el('help-site-link');
    check('it points at the public service by default',
        link.href === 'https://gottabikesaucelunatic-production.up.railway.app/help', link.href);
    // Someone running their own deployment must reach their own page: it is the
    // only one whose quotas and model list match what they are actually getting.
    settingsStore.set('hostedBaseUrl', 'https://my-own-instance.example/');
    check('and at your own service when you set one',
        link.href === 'https://my-own-instance.example/help', link.href);
    settingsStore.set('hostedBaseUrl', '');
    check('a cleared URL falls back rather than breaking',
        link.href.endsWith('.up.railway.app/help'), link.href);
}

section('the update check does not get in the way');
// installGlobals() makes fetch throw, so this is the offline case: the settings
// window has to open regardless, and nothing may be left half-rendered.
check('the picker is still populated', groups()[0].values.includes('tour'));
check('no notice, because nothing was fetched', el('prompt-notice').hidden);
check('the off switch reflects the default', el('prompt-updates').value === 'auto',
    el('prompt-updates').value);

section('a pending notice is shown, and dismissible');
// A realistic post-update state: Lunatic rewritten, Velodrome new, and the
// previous Lunatic text retained so the diff has a left-hand side.
settingsStore.set('promptUpdateNotice', {
    updated: [{ id: 'lunatic', label: 'Lunatic', from: 1, to: 2 }],
    added: [{ id: 'velodrome', label: 'Velodrome' }]
});
settingsStore.set('builtinPrompts', {
    revision: 'r2',
    fetchedAt: Date.now(),
    data: [
        { id: 'lunatic', version: 2, label: 'Lunatic', description: 'Louder.',
          systemPrompt: 'Shout the race.\nRule one, revised.\nRule two.',
          userPromptTemplate: '{raceContext}\n{events}\n{watchingSection}\n{riders}\n{recentLines}' },
        { id: 'velodrome', version: 1, label: 'Velodrome', description: 'Track racing.',
          systemPrompt: 'Call a track race.\nOne sentence.',
          userPromptTemplate: '{raceContext}\n{events}\n{watchingSection}\n{riders}\n{recentLines}' }
    ],
    previous: {
        lunatic: { version: 1, systemPrompt: 'Shout the race.\nRule one.\nRule two.',
                   userPromptTemplate: '{raceContext}\n{events}\n{watchingSection}\n{riders}\n{recentLines}' }
    }
});
check('the notice appears', !el('prompt-notice').hidden);
check('naming both changes',
    /Lunatic/.test(el('prompt-notice-text').textContent) &&
    /Velodrome/.test(el('prompt-notice-text').textContent),
    el('prompt-notice-text').textContent);
check('and saying your own are safe', /unchanged/.test(el('prompt-notice-text').textContent));
section('the notice can show what actually changed');
check('a diff is offered', !el('prompt-notice-diff').hidden);
check('but not opened yet', el('prompt-notice-diff-view').hidden);
fire(el('prompt-notice-diff'), 'click');
check('clicking opens it', !el('prompt-notice-diff-view').hidden);
check('with something in it', el('prompt-notice-diff-view').children.length > 0);
{
    // The real thing: the revised rule shown as a replacement, labelled by voice.
    const lines = el('prompt-notice-diff-view').children
        .flatMap(f => f.children).map(n => n.textContent);
    check('the old wording is shown as removed', lines.some(t => /^-?\s*Rule one\.$/.test(t.trim())),
        JSON.stringify(lines));
    check('and the new wording as added', lines.some(t => /Rule one, revised\./.test(t)));
    check('under the voice it belongs to', lines.some(t => /^Lunatic · /.test(t)),
        lines.filter(t => /·/.test(t)).join(' | '));
}
fire(el('prompt-notice-diff'), 'click');
check('and clicking again closes it', el('prompt-notice-diff-view').hidden);

section('a new voice is marked in the picker');
{
    const names = picker.children[0].children.map(o => o.textContent);
    check('the new one says so', names.some(n => / — new$/.test(n)), names.join(' | '));
    check('and the others do not', names.filter(n => / — new$/.test(n)).length === 1);
}

fire(el('prompt-notice-dismiss'), 'click');
check('dismiss hides it', el('prompt-notice').hidden);
check('and it stays dismissed', settingsStore.get('promptUpdateNotice') === null);
check('the "new" marker goes with it',
    !picker.children[0].children.some(o => / — new$/.test(o.textContent)));
check('and the retained previous text is dropped',
    Object.keys(settingsStore.get('builtinPrompts')?.previous || {}).length === 0);

section('a copy whose source has moved on');
{
    // A service update that rewrites Lunatic, and a copy made before it.
    settingsStore.set('builtinPrompts', {
        revision: 'r3', fetchedAt: Date.now(),
        data: [{
            id: 'lunatic', version: 4, label: 'Lunatic', description: 'Louder than ever.',
            systemPrompt: 'You are a live bike-race commentator.\nRewritten rule.\nAnother.',
            userPromptTemplate: '{raceContext}\n{events}\n{watchingSection}\n{riders}\n{recentLines}'
        }]
    });
    picker.value = 'lunatic';
    fire(picker, 'change');
    fire(el('prompt-duplicate-btn'), 'click');
    check('a fresh copy says nothing', el('prompt-stale').hidden);

    // Now the service moves on again, past the version they copied.
    const raw = settingsStore.get('builtinPrompts');
    settingsStore.set('builtinPrompts', {
        ...raw,
        data: [{ ...raw.data[0], version: 9, systemPrompt: 'Completely different now.' }]
    });
    fire(picker, 'change');
    check('now it does', !el('prompt-stale').hidden);
    check('naming the versions', /version 4 to 9/.test(el('prompt-stale-text').textContent),
        el('prompt-stale-text').textContent);
    check('and promising their text is safe',
        /untouched/.test(el('prompt-stale-text').textContent));
    check('their text really is', el('custom-system-prompt').value.includes('Rewritten rule'),
        el('custom-system-prompt').value.slice(0, 40));

    fire(el('prompt-stale-diff'), 'click');
    check('the diff opens', !el('prompt-stale-diff-view').hidden);
    check('showing theirs against the new original',
        el('prompt-stale-diff-view').children.length > 0);

    fire(el('prompt-revert-btn'), 'click');
    check('resetting takes the new original',
        el('custom-system-prompt').value === 'Completely different now.',
        el('custom-system-prompt').value);
    check('and the notice clears', el('prompt-stale').hidden);
}

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
