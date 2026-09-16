#!/usr/bin/env node
/**
 * Boot the OVERLAY window against a stub DOM.
 *
 * The companion to settings-boot-test.mjs, and for the same reason: nothing
 * else executes this code before a rider opens the window mid-race, which is
 * the worst possible place to discover a ReferenceError. The overlay half
 * carries the v0.4.0 status-dot / hover-cost / inline-history changes, and it
 * is also where the ~1Hz `nearby` handler lives -- a lot of logic that had
 * never run outside Sauce.
 *
 * Separate process from the settings test on purpose: announcer.mjs holds
 * module-level state and runs migrateLegacySettings() at import, so sharing one
 * process would let one window's boot colour the other's results.
 *
 *   node scripts/overlay-boot-test.mjs
 */
import {
    installGlobals, loadAnnouncer, el, check, section, finish, bailOnBootFailure
} from './lib/stub-dom.mjs';

installGlobals();
const { mod, common: { settingsStore, subscribed } } = await loadAnnouncer();

section('the overlay boots at all');
let bootErr = null;
try {
    await mod.lunaticAnnouncerMain();
} catch (err) {
    bootErr = err;
}
check('lunaticAnnouncerMain() runs to completion', !bootErr,
    bootErr ? `${bootErr.constructor.name}: ${bootErr.message}` : '');
bailOnBootFailure(bootErr);

// It leaves a 5s watchdog behind; nothing here should wait on it.
process.on('exit', () => clearInterval());

section('the status dots carry state in a class and detail in the tooltip');
const api = el('api-status');
check('unconfigured reads as not-configured', api._classes.has('not-configured'),
    [...api._classes].join(' '));
check('and is not also marked connected', !api._classes.has('connected'));
check('the tooltip says why', /No AI provider configured/.test(api.title), api.title);

const auto = el('auto-update-status');
check('the auto-update dot has a state class',
    ['active', 'manual', 'paused'].some(c => auto._classes.has(c)), [...auto._classes].join(' '));
check('and a tooltip', !!auto.title, auto.title);

section('configuring a provider live updates the dot');
// Through settingsStore, so this exercises the overlay's own `changed`
// listener rather than calling the internal function directly.
const placeholder = document.querySelector('#current-commentary .placeholder-text');
placeholder.textContent = 'Pick an AI provider in settings…';
check('before: the overlay is paused', auto._classes.has('paused'));
settingsStore.set('claudeApiKey', 'sk-ant-api03-not-a-real-key');
check('the dot goes connected', api._classes.has('connected'), [...api._classes].join(' '));

section('F01: configuring a provider with the overlay open STARTS it');
// The gear lives on the overlay, so this is every first run. It used to leave
// the overlay paused, still saying "Pick an AI provider", with the dot green.
check('the placeholder no longer says to pick a provider',
    placeholder.textContent === 'Waiting for ride data…', placeholder.textContent);
check('and it is no longer paused', !auto._classes.has('paused'), [...auto._classes].join(' '));
check('the pause button shows the running state', el('pause-btn')._classes.has('active'));

// A rider who paused ON PURPOSE and then swaps provider must stay paused.
settingsStore.set('commentaryPaused', true);
settingsStore.set('claudeApiKey', '');            // unconfigured again
settingsStore.set('claudeApiKey', 'sk-ant-api03-another-key');
check('a deliberate pause survives a provider change', auto._classes.has('paused'),
    [...auto._classes].join(' '));
settingsStore.set('commentaryPaused', false);
check('and drops not-configured', !api._classes.has('not-configured'));
check('the tooltip names the provider', /ready/.test(api.title), api.title);

section('F10: the cadence dot describes both triggers, and manual means manual');
{
    // The section above left it paused on purpose; come back through the same
    // edge the overlay uses, since isPaused is module state and the store key
    // alone does not move it.
    settingsStore.set('claudeApiKey', '');
    settingsStore.set('claudeApiKey', 'sk-ant-api03-cadence-key');

    // Timers are how the lie was load-bearing: restartAutoUpdate() read a
    // stored 0 as 60, because its `|| 60` fell back on the VALUE rather than on
    // a failed parse. So "Manual only" started a minute timer. Record what gets
    // scheduled.
    const realSetInterval = globalThis.setInterval;
    let scheduled = [];
    globalThis.setInterval = (fn, ms) => { scheduled.push(ms); return realSetInterval(fn, ms); };

    // Reset between the two writes, so `scheduled` holds what the SETTLED
    // combination schedules and not what the half-applied one did.
    const set = (events, clock) => {
        settingsStore.set('eventDriven', events);
        scheduled = [];
        settingsStore.set('updateInterval', clock);
    };

    set(true, 0);
    check('events with no clock is NOT manual — it still fires, and it is paid',
        auto._classes.has('active') && !auto._classes.has('manual'),
        `${[...auto._classes].join(' ')} — ${auto.title}`);
    check('and the tooltip says what it is doing',
        auto.title === 'Listening for race events', auto.title);

    set(false, 60);
    check('clock only: the tooltip names the interval',
        auto.title === 'Speaking every minute', auto.title);
    check('and a timer really is scheduled', scheduled.includes(60000), scheduled.join(', '));

    set(false, 0);
    check('both off is the only manual state', auto._classes.has('manual'),
        [...auto._classes].join(' '));
    check('the tooltip points at the refresh button',
        /Manual only/.test(auto.title), auto.title);
    check('and NOTHING is scheduled — this is the 60s timer the `|| 60` used to start',
        !scheduled.length, scheduled.join(', '));

    set(true, 45);
    check('back to the shipped default: active, and the tooltip says both',
        auto._classes.has('active') && /race events/.test(auto.title) &&
        /at least every 45 seconds/.test(auto.title),
        `${[...auto._classes].join(' ')} — ${auto.title}`);
    check('still no wall-clock timer — the 1Hz data tick schedules it',
        !scheduled.length, scheduled.join(', '));

    globalThis.setInterval = realSetInterval;
}

section('the cost readout is a $ with the figure in the tooltip');
const cost = el('session-cost');
check('the overlay shows a bare $', cost.textContent === '$', JSON.stringify(cost.textContent));
check('the figure is in the tooltip', /\$\d/.test(cost.title), cost.title);
check('it is not marked free on a paid provider', !cost._classes.has('free'));

settingsStore.set('aiProvider', 'hosted');
check('hosted shows the allowance instead', /free calls remaining|free calls left/i.test(cost.title),
    cost.title);
check('and is marked free', cost._classes.has('free'));
settingsStore.set('aiProvider', 'anthropic');

section('history is a setting, and needs something to show');
const history = el('history-container');
settingsStore.set('showHistory', true);
check('nothing to show yet, so it stays hidden', history.hidden === true);
settingsStore.set('showHistory', false);
check('toggling the setting does not throw', true);

section('the overlay reads improved voices but never fetches them');
// The overlay fires commentary within a second of real ride data. A prompt
// fetch must never sit in front of that -- it reads the cache the settings
// window filled, and nothing else. installGlobals() makes fetch throw, so a
// stray call would have surfaced as a boot failure above.
settingsStore.set('builtinPrompts', {
    revision: 'r9',
    fetchedAt: Date.now(),
    data: [{
        id: 'tour', version: 4, label: 'Tour de France', description: 'x',
        systemPrompt: 'IMPROVED TOUR PROMPT', userPromptTemplate: '{riders}'
    }]
});
const lib = await import('../pages/src/prompt-library.mjs');
check('the cache is what resolves', lib.builtins(settingsStore).tour.systemPrompt === 'IMPROVED TOUR PROMPT');
check('and the overlay would send it', lib.resolvePrompt(settingsStore).systemPrompt === 'IMPROVED TOUR PROMPT');

section('the ~1Hz nearby handler');
const nearby = subscribed.get('nearby');
check('the overlay subscribed to nearby', typeof nearby === 'function');

// No provider configured, so the handler walks its whole data path without
// trying to reach the network at the end of it.
settingsStore.set('claudeApiKey', '');

let dataErr = null;
try {
    nearby([]);            // Sauce sends an empty array between events
    nearby(null);          // and, on some builds, nothing at all
} catch (err) { dataErr = err; }
check('an empty tick is survivable', !dataErr, dataErr ? String(dataErr) : '');

// Front-to-back, already sorted, with the sign convention Sauce actually uses:
// a NEGATIVE gap means the rider is up the road.
const pack = [
    { athleteId: 1, gap: -12.4, watching: false, athlete: { fullname: 'A Rider' },
      state: { heartrate: 168, speed: 41.2, grade: 0.03 },
      stats: { power: { smooth: { 5: 320, 60: 295 } } } },
    { athleteId: 2, gap: 0, watching: true, athlete: { fullname: 'You' },
      state: { heartrate: 172, speed: 41.0, grade: 0.03 },
      stats: { power: { smooth: { 5: 340, 60: 310 } } } },
    { athleteId: 3, gap: 8.1, watching: false, athlete: { fullname: 'B Rider' },
      state: { heartrate: 165, speed: 40.4, grade: 0.03 },
      stats: { power: { smooth: { 5: 280, 60: 275 } } } },
    { athleteId: 4, gap: 20.0, watching: false, athlete: { type: 'PACER_BOT', fullname: 'Bot' },
      state: { heartrate: 0, speed: 40.0, grade: 0.03 },
      stats: { power: { smooth: { 5: 200, 60: 200 } } } }
];
try {
    for (let i = 0; i < 5; i++) nearby(pack);   // several ticks, so tracks build up
} catch (err) { dataErr = err; }
check('a real pack is survivable', !dataErr, dataErr ? `${dataErr.constructor.name}: ${dataErr.message}` : '');

section('G01: the overlay publishes the athlete id the settings window needs');
{
    // The service buckets an anonymous rider by athlete id when a request
    // carries X-Lunatic-Athlete. Only this window subscribes to `nearby`, so
    // only this window knows the id — and the settings window's allowance
    // readout described a different, untouched bucket until it did.
    check('the watched id is published', settingsStore.get('/gotta-bike-lunatic-athlete-id') === 2,
        String(settingsStore.get('/gotta-bike-lunatic-athlete-id')));

    // ~1Hz: every set() wakes both windows' listeners, so an unchanged id
    // must not write.
    let writes = 0;
    settingsStore.addEventListener('set', ev => {
        if (ev.data.key === '/gotta-bike-lunatic-athlete-id') writes++;
    });
    for (let i = 0; i < 5; i++) nearby(pack);
    check('an unchanged id does not rewrite it', writes === 0, `${writes} write(s)`);

    // An empty tick means "nobody to talk about", not "this rider is gone".
    // The settings window may be opened long after the ride.
    nearby([]);
    check('an empty tick does not clear it', settingsStore.get('/gotta-bike-lunatic-athlete-id') === 2);
}

section('F10: "manual only" also means no unasked-for first line');
{
    // The first-data fire ignored the cadence settings entirely: one line
    // arrived the moment ride data did, every ride, however the rider had set
    // things. generateCommentary() marks the container 'streaming' before its
    // first await, so a tick either called it or did not.
    const container = el('current-commentary');
    const fired = () => container._classes.has('streaming');

    settingsStore.set('claudeApiKey', 'sk-ant-api03-first-data-key');
    settingsStore.set('eventDriven', false);
    settingsStore.set('updateInterval', 0);

    nearby([]);                             // an empty tick rearms the first fire
    container._classes.delete('streaming');
    nearby(pack);
    check('manual only: the first tick of ride data says nothing', !fired(),
        [...container._classes].join(' '));

    // Not vacuous: the same tick under the shipped defaults does fire.
    settingsStore.set('eventDriven', true);
    settingsStore.set('updateInterval', 45);
    nearby([]);
    container._classes.delete('streaming');
    nearby(pack);
    check('and with the defaults it does speak', fired(), [...container._classes].join(' '));
    // The stub has no network, so this logs one expected "[Lunatic] provider
    // error" as the call unwinds. That log line IS the evidence it fired.
    await new Promise(r => setImmediate(r));
}

const watchChange = subscribed.get('watching-athlete-change');
check('a camera cut is handled', typeof watchChange === 'function');
try { watchChange?.(); } catch (err) { check('camera cut threw', false, String(err)); }

finish();
