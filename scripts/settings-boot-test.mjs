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

// Two links to the online help now: the Help tab's, and the one under the
// Anthropic Model select that replaced Help's per-1M price table (F09).
const onlineLinks = [el('help-site-link'), makeEl('a')];

installGlobals({ providerRows: Object.values(rows),
                 selectors: { '.tab-btn': tabBtns, '.tab-panel': tabPanels,
                              '.help-online-link': onlineLinks } });
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
// Speech is on by default now, so the row warns that it will talk rather than
// that it will not. Both branches are asserted; the wrong one would be a lie
// either way round.
check('and says it will speak, because it will',
    /speaks aloud/.test(el('api-next-step').textContent), el('api-next-step').textContent);
settingsStore.set('ttsEnabled', false);
check('muted, it says where the switch is instead',
    /Speech is off/.test(el('api-next-step').textContent), el('api-next-step').textContent);
settingsStore.set('ttsEnabled', true);

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

section('G06: a test that hangs is bounded, cancellable and legible');
{
    // A host that accepts the connection and then says nothing: fetch never
    // settles. This used to leave the button disabled and "Testing..." up
    // until Chromium's own connect timeout, minutes later.
    // Start from a KNOWN-GOOD box, so "cancel did not mark it failed" is
    // distinguishable from "it was already failed".
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), headers: { get: () => null } });
    fire(el('test-api-btn'), 'click');
    await settle();
    check('(setup) the box is green before the hang', el('api-info').className === 'api-info connected',
        el('api-info').className);

    let seenSignal = null;
    globalThis.fetch = (url, opts) => new Promise((_, reject) => {
        seenSignal = opts.signal;
        opts.signal.addEventListener('abort', () =>
            reject(opts.signal.reason || new DOMException('aborted', 'AbortError')));
    });
    const btn = el('test-api-btn');
    fire(btn, 'click');
    await settle();
    check('the request carries an abort signal', !!seenSignal);
    check('the button offers a way out, not a disabled control',
        btn.textContent === 'Cancel' && !btn.disabled, `${btn.textContent} disabled=${btn.disabled}`);
    check('and says it is testing', el('api-test-status').className === 'loading');

    // Clicking again cancels rather than starting a second test.
    fire(btn, 'click');
    await settle();
    check('cancelling ends the test', btn.textContent === 'Test Connection', btn.textContent);
    check('and says so', el('api-test-status').textContent === 'Test cancelled.',
        el('api-test-status').textContent);
    // A cancelled test says nothing about the settings, so the Status box must
    // not go red.
    check('a cancelled test leaves the earlier verdict alone',
        el('api-info').className === 'api-info connected', el('api-info').className);
    check('focus returns to the button', document.activeElement === btn);

    // The timeout path, and the copy a rider acts on.
    globalThis.fetch = async () => { throw new DOMException('timed out', 'TimeoutError'); };
    fire(btn, 'click');
    await settle();
    check('a timeout names the host and the bound',
        /No reply from api\.anthropic\.com after 15 seconds/.test(el('api-test-status').textContent),
        el('api-test-status').textContent);
    check('and it does mark the settings failed', el('api-info').className === 'api-info failed');

    // The bare "Failed to fetch" every network problem produces.
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
    fire(btn, 'click');
    await settle();
    check('an unreachable host is named too',
        /Could not reach api\.anthropic\.com/.test(el('api-test-status').textContent),
        el('api-test-status').textContent);
    globalThis.fetch = async () => { throw new Error('no network in this test'); };
}

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

// F08: Help carried a hand-written voice list that drifted to two of four,
// and a whole section describing the design the prompt library replaced. The
// list is rendered from library.listBuiltins() now, so it cannot drift from
// the picker -- which is the property worth asserting.
// F14: eight checkboxes read a key a DIFFERENT mod writes. Without GOTTA.BIKE
// Sauce installed and populated every one is a no-op, three ship ticked, and
// nothing on the tab said so — the settings window did not even load the data.
section('F14: the GOTTA.BIKE section says whether there is anything to read');
{
    const line = el('stored-data-status');
    const sect = el('stored-data-section');
    check('empty: it says the fields do nothing yet',
        /not installed, or has imported nothing yet/.test(line.textContent), line.textContent);
    check('and offers somewhere to get it',
        line.children.some(c => c.tagName === 'A' && /GOTTA_BIKE_sauce/.test(c.href)),
        line.children.map(c => c.tagName).join(','));
    check('the section is dimmed, not hidden', sect._classes.has('inert') && !sect.hidden);

    // GOTTA.BIKE Sauce importing while this window is open.
    settingsStore.set('/gotta-bike-sauce-athlete-data', { 11: { zpFTP: 300 }, 22: { zpFTP: 280 } });
    check('a live import is counted', /Stored data for 2 riders found/.test(line.textContent),
        line.textContent);
    check('and the section comes back to full strength', !sect._classes.has('inert'));
    check('the "get it" link is gone once it is there',
        !line.children.some(c => c.tagName === 'A'), line.textContent);

    settingsStore.set('/gotta-bike-sauce-athlete-data', { 11: { zpFTP: 300 } });
    check('one rider is not "1 riders"', /for 1 rider found/.test(line.textContent), line.textContent);
}

// F45: Test Voice had no status element and no speaking state at all. It
// spoke, or it silently did nothing, and a rider could not tell which.
section('F45: Test Voice says what happened');
{
    const status = el('voice-test-status');
    speechSynthesis.spoken.length = 0;

    fire(el('test-voice-btn'), 'click');
    check('it actually speaks', speechSynthesis.spoken.length === 1,
        `${speechSynthesis.spoken.length} utterance(s)`);
    check('with words a commentator would say',
        /Rodriguez/.test(speechSynthesis.spoken[0].text), speechSynthesis.spoken[0].text);
    check('on the picked voice', speechSynthesis.spoken[0].voice?.name === 'Daniel',
        String(speechSynthesis.spoken[0].voice?.name));
    check('and says so while it is speaking', /Speaking/.test(status.textContent),
        status.textContent);
    // onstart/onend arrive after speak() returns, as they do in a browser --
    // which is the whole reason speak() hands the utterance back.
    await new Promise(r => setImmediate(r));
    check('and clears the status when it finishes', status.textContent === '',
        JSON.stringify(status.textContent));

    // It used to write ttsEnabled true, speak, and write it back false: two
    // store writes that woke BOTH windows and flickered the overlay's mute
    // button every time anyone pressed Test.
    settingsStore.set('ttsEnabled', false);
    let writes = 0;
    settingsStore.addEventListener('set', ev => { if (ev.data.key === 'ttsEnabled') writes++; });
    speechSynthesis.spoken.length = 0;
    fire(el('test-voice-btn'), 'click');
    check('muted, an explicit test still speaks', speechSynthesis.spoken.length === 1,
        `${speechSynthesis.spoken.length} utterance(s)`);
    check('and it does not touch the shared setting to do it', writes === 0, `${writes} write(s)`);
    check('which is still off afterwards', settingsStore.get('ttsEnabled') === false);
    settingsStore.set('ttsEnabled', true);
}

section('the Help tab lists the built-in voices from the library');
{
    const dl = el('help-voices');
    const labels = dl.children.filter(c => c.tagName === 'DT').map(c => c.textContent);
    const descs = dl.children.filter(c => c.tagName === 'DD').map(c => c.textContent);
    check('one entry per built-in, same set as the picker',
        labels.length === groups()[0].values.length, `${labels.length} vs ${groups()[0].values.length}`);
    check('all four are named', labels.includes('Tour de France') && labels.includes('Lunatic') &&
        labels.includes('Old Pro') && labels.includes('Tactical Coach'), labels.join(', '));
    check('each has its description', descs.length === labels.length && descs.every(d => d.length > 10),
        descs.join(' | '));
    // It re-renders on every library change; a rebuild that appended would have
    // doubled the list by now, since this test has made and deleted prompts.
    check('re-rendering replaces the list rather than appending it',
        dl.children.length === labels.length * 2, String(dl.children.length));
}

section('the Help tab links to the help page');
{
    const link = el('help-site-link');
    check('every link to the online help is pointed at it, not just the first',
        onlineLinks[1].href === link.href, `${onlineLinks[1].href} vs ${link.href}`);
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

section('G01: the settings window asks about the bucket commentary spends from');
{
    // Only the overlay subscribes to `nearby`, so it publishes the watched
    // athlete id to a global key. Without it this request is bucketed by
    // device token while commentary is bucketed by athlete — a pristine
    // allowance reported beside an overlay that is out of calls.
    settingsStore.set('/gotta-bike-lunatic-athlete-id', 123456);
    settingsStore.set('/gotta-bike-lunatic-device-token', 'lun_mock');
    // serviceUrl() reads the input, not the store — as it must, so a rider can
    // type a URL and press Connect in one go.
    el('hosted-base-url').value = 'https://service.example';
    settingsStore.set('aiProvider', 'hosted');

    const seen = [];
    globalThis.fetch = async (url, opts = {}) => {
        seen.push({ url: String(url), headers: opts.headers || {} });
        const body = String(url).endsWith('/v1/models')
            ? { data: [{ id: 'free-fast', label: 'Fast' }] }
            : { remaining: 3, limit: 150, bucket: 'z:123456' };
        return { ok: true, status: 200, json: async () => body, headers: { get: () => null } };
    };
    fire(el('hosted-connect-btn'), 'click');
    await settle();

    const quotaReq = seen.find(r => r.url.includes('/v1/quota'));
    check('the quota request was made', !!quotaReq, seen.map(r => r.url).join(', '));
    check('and carries the athlete id', quotaReq?.headers['X-Lunatic-Athlete'] === '123456',
        JSON.stringify(quotaReq?.headers));
    check('the allowance is stored for the overlay', settingsStore.get('/gotta-bike-lunatic-quota') === 3,
        String(settingsStore.get('/gotta-bike-lunatic-quota')));

    // Belt and braces: an answer about the wrong bucket must not overwrite the
    // shared reading the overlay renders from.
    globalThis.fetch = async (url) => ({
        ok: true, status: 200, headers: { get: () => null },
        json: async () => String(url).endsWith('/v1/models')
            ? { data: [{ id: 'free-fast', label: 'Fast' }] }
            : { remaining: 150, limit: 150, bucket: 'd:someDevice' }
    });
    fire(el('hosted-connect-btn'), 'click');
    await settle();
    check('a device-bucket answer does not overwrite it',
        settingsStore.get('/gotta-bike-lunatic-quota') === 3,
        String(settingsStore.get('/gotta-bike-lunatic-quota')));
    check('and it is labelled as this install, not this month',
        /left for this install/.test(el('hosted-quota').textContent), el('hosted-quota').textContent);
    globalThis.fetch = async () => { throw new Error('no network in this test'); };
}

// G02: "0 left" is where a free rider sits for most of the month -- the
// anonymous allowance is about one racing hour -- and it rendered identically
// to a healthy one: "Connected", a green box, grey help text, no remedy, no
// date, while the overlay said "Monthly limit reached".
section('G02: an exhausted allowance does not look like a healthy one');
{
    const quotaBody = (remaining, extra = {}) => ({
        remaining, limit: 150, bucket: 'z:123456',
        resetsAt: '2026-10-01T00:00:00.000Z', tier: 'anon', ...extra
    });
    const serve = body => { globalThis.fetch = async (url) => ({
        ok: true, status: 200, headers: { get: () => null },
        json: async () => String(url).endsWith('/v1/models')
            ? { data: [{ id: 'free-fast', label: 'Fast' }] } : body
    }); };

    serve(quotaBody(0));
    fire(el('hosted-connect-btn'), 'click');
    await settle();

    check('the connection row says it is out, not Connected',
        /Out of free calls until (1 October|October 1)/.test(el('hosted-status').textContent),
        el('hosted-status').textContent);
    check('the Status box is not green', el('api-info').className.includes('exhausted'),
        el('api-info').className);
    check('and says when it comes back',
        /Out of free calls until (1 October|October 1)/.test(el('api-status-text').textContent),
        el('api-status-text').textContent);
    check('the allowance line names the remedy',
        /Sign in with Discord/.test(el('hosted-quota').textContent), el('hosted-quota').textContent);
    // The date follows the rider's locale, so accept either order.
    check('and the reset date', /resets (1 October|October 1)/.test(el('hosted-quota').textContent),
        el('hosted-quota').textContent);
    check('at error weight, not grey help text',
        /error/.test(el('hosted-quota').className), el('hosted-quota').className);
    // ...and says nothing at all, rather than repeating the line above it.
    check('the next-step row stops saying "close this window and ride"',
        el('api-next-step').hidden === true, el('api-next-step').textContent);

    // A Discord rider at zero has a different remedy: their own key.
    serve(quotaBody(0, { tier: 'account' }));
    fire(el('hosted-connect-btn'), 'click');
    await settle();
    check('an account at zero is pointed at its own key, not at Discord',
        /your own API key/.test(el('hosted-quota').textContent) &&
        !/Sign in with Discord/.test(el('hosted-quota').textContent),
        el('hosted-quota').textContent);

    // Warn before the overlay goes quiet, not after.
    serve(quotaBody(9));
    fire(el('hosted-connect-btn'), 'click');
    await settle();
    check('nearly out is amber and says so', /warn/.test(el('hosted-quota').className) &&
        /9 of 150/.test(el('hosted-quota').textContent),
        `${el('hosted-quota').className} — ${el('hosted-quota').textContent}`);

    serve(quotaBody(120));
    fire(el('hosted-connect-btn'), 'click');
    await settle();
    check('a healthy allowance is plain', el('hosted-quota').className === 'help-text',
        el('hosted-quota').className);
    check('and back to Connected', el('hosted-status').textContent === 'Connected',
        el('hosted-status').textContent);

    // F17: one readout. The Cost Tracking card duplicated the allowance from a
    // second source and drifted from it, under a "Session cost:" label that was
    // neither a cost nor per-session, with a reset button that did not reset it.
    check('the Cost Tracking card is hidden on hosted', el('cost-section').hidden === true);

    // It must stay live: spending during a ride changes it under this window.
    settingsStore.set('/gotta-bike-lunatic-quota', 0);
    check('spending down to zero updates the line without a refetch',
        /^0 of 150 free calls left — resets/.test(el('hosted-quota').textContent),
        el('hosted-quota').textContent);
    check('and the Status box with it', el('api-info').className.includes('exhausted'),
        el('api-info').className);

    globalThis.fetch = async () => { throw new Error('no network in this test'); };
}

// G03: the pending sign-in had no exit. Three concrete failures, all here.
section('G03: a sign-in in flight can be escaped, and survives the window');
{
    el('hosted-base-url').value = 'https://service.example';
    settingsStore.set('/gotta-bike-lunatic-device-token', '');
    settingsStore.set('/gotta-bike-lunatic-pairing', null);

    // Never completes: the browser half is where a rider walks away.
    globalThis.fetch = async (url, opts = {}) => {
        if (opts.signal?.aborted) throw new DOMException('aborted', 'AbortError');
        const body = String(url).endsWith('/v1/pair/start')
            ? { verifyUrl: 'https://service.example/pair/ABCD', pollToken: 'pt_1', expiresIn: 900 }
            : { status: 'pending' };
        return { ok: true, status: 200, json: async () => body, headers: { get: () => null } };
    };

    fire(el('hosted-signin-btn'), 'click');
    await settle();

    check('there is a way out', el('hosted-cancel-btn').hidden === false);
    check('and the sign-in button is out of the way', el('hosted-signin-btn').hidden === true);
    // Disabled grey beside a live blue actively steered the rider here, and
    // pressing it produced a working connection plus a red "Timed out" 15
    // minutes later.
    check('"Connect anonymously" cannot be pressed mid-flow',
        el('hosted-connect-btn').disabled === true);
    check('and the window says to stay open', el('hosted-signin-hint').hidden === false);
    check('the browser link is offered', el('hosted-signin-link').hidden === false,
        el('hosted-signin-link').href);
    check('the pairing is persisted, so closing this window does not strand it',
        settingsStore.get('/gotta-bike-lunatic-pairing')?.pollToken === 'pt_1',
        JSON.stringify(settingsStore.get('/gotta-bike-lunatic-pairing')));

    fire(el('hosted-cancel-btn'), 'click');
    await settle();
    check('cancelling ends it', el('hosted-cancel-btn').hidden === true &&
        el('hosted-signin-btn').hidden === false);
    check('re-enables the anonymous path', el('hosted-connect-btn').disabled === false);
    check('drops the stale browser link', el('hosted-signin-link').hidden === true);
    check('forgets the pairing', !settingsStore.get('/gotta-bike-lunatic-pairing'),
        JSON.stringify(settingsStore.get('/gotta-bike-lunatic-pairing')));
    check('and says so without calling it an error',
        el('hosted-status').textContent === 'Sign-in cancelled' &&
        el('hosted-status').className !== 'error',
        `${el('hosted-status').textContent} / ${el('hosted-status').className}`);

    globalThis.fetch = async () => { throw new Error('no network in this test'); };
}

section('G03: a key can be pasted, because the service tells riders to');
{
    // The service's sign-in page says to copy the key in by hand when the mod
    // did not collect it. There was no field to copy it into.
    settingsStore.set('/gotta-bike-lunatic-device-token', '');
    el('hosted-paste-key').value = 'not-a-key';
    fire(el('hosted-paste-btn'), 'click');
    await settle();
    check('junk is refused before it is stored',
        /does not look like a key/.test(el('hosted-status').textContent),
        el('hosted-status').textContent);
    check('and nothing was stored', !settingsStore.get('/gotta-bike-lunatic-device-token'));

    globalThis.fetch = async (url) => ({
        ok: true, status: 200, headers: { get: () => null },
        json: async () => String(url).endsWith('/v1/models')
            ? { data: [{ id: 'free-fast', label: 'Fast' }] }
            : { remaining: 400, limit: 400, bucket: 'u:disc', tier: 'account',
                resetsAt: '2026-10-01T00:00:00.000Z' }
    });
    el('hosted-paste-key').value = 'luna_pasted_by_hand';
    fire(el('hosted-paste-btn'), 'click');
    await settle();
    check('a real key is adopted',
        settingsStore.get('/gotta-bike-lunatic-device-token') === 'luna_pasted_by_hand',
        String(settingsStore.get('/gotta-bike-lunatic-device-token')));
    check('the field is cleared once it is in', el('hosted-paste-key').value === '',
        el('hosted-paste-key').value);
    check('and it connects', el('hosted-status').textContent === 'Connected',
        el('hosted-status').textContent);

    // A key the service rejects must not be left behind as the stored token.
    settingsStore.set('/gotta-bike-lunatic-device-token', '');
    globalThis.fetch = async () => ({
        ok: false, status: 401, headers: { get: () => null },
        json: async () => ({ error: { message: 'Missing or invalid token.' } })
    });
    el('hosted-paste-key').value = 'luna_stale_key';
    fire(el('hosted-paste-btn'), 'click');
    await settle();
    check('a rejected key is not left in storage',
        !settingsStore.get('/gotta-bike-lunatic-device-token'),
        String(settingsStore.get('/gotta-bike-lunatic-device-token')));
    check('and the refusal is shown', /invalid token/i.test(el('hosted-status').textContent),
        el('hosted-status').textContent);

    globalThis.fetch = async () => { throw new Error('no network in this test'); };
}

section('sign-out');
const fired = fire(el('hosted-signout-btn'), 'click');
check('sign-out is wired', fired === 1);
check('sign-out clears the token', !settingsStore.get(TOKEN_KEY));
check('sign-out updates the badge', badge.textContent === 'Not connected', badge.textContent);

finish();
