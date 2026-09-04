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
settingsStore.set('claudeApiKey', 'sk-ant-api03-not-a-real-key');
check('the dot goes connected', api._classes.has('connected'), [...api._classes].join(' '));
check('and drops not-configured', !api._classes.has('not-configured'));
check('the tooltip names the provider', /ready/.test(api.title), api.title);

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

const watchChange = subscribed.get('watching-athlete-change');
check('a camera cut is handled', typeof watchChange === 'function');
try { watchChange?.(); } catch (err) { check('camera cut threw', false, String(err)); }

finish();
