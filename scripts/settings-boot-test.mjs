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
