#!/usr/bin/env node
/**
 * The Data Fields tab: every control on it does something, and upgrading lands
 * the rider where they were.
 *
 * Six of nineteen checkboxes on this tab were read by nothing at all -- not by
 * riderLine(), not by anything else in the repo. Ticking "20-minute power",
 * "Critical Power", "Power curve" or "Route suitability" changed nothing,
 * forever, with no feedback, and dead "5-second power" sat in the first visible
 * row beside live "5s rolling power". Nobody noticed because a checkbox that
 * saves looks exactly like a checkbox that works.
 *
 * So the first check here is static and blunt: every named control on that tab
 * must appear in announcer.mjs as a settings read. It is the check whose absence
 * let a third of the tab go inert.
 *
 * The second part is the powerMode migration, one process per case, because
 * announcer.mjs migrates at import and holds module-level state.
 *
 *   node scripts/data-fields-test.mjs
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

let bad = 0;
const check = (n, ok, d = '') => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`);
    if (!ok) bad++;
};
const section = t => console.log(`\n=== ${t} ===`);

// ---------------------------------------------------------------------------
section('every control on the tab is read by the prompt builder');

const html = readFileSync(join(REPO, 'pages/announcer-settings.html'), 'utf8');
const mjs = readFileSync(join(REPO, 'pages/src/announcer.mjs'), 'utf8');

const tabStart = html.indexOf('<div id="data-tab"');
const tabEnd = html.indexOf('<!-- Help Tab -->');
check('the Data Fields tab was found', tabStart > 0 && tabEnd > tabStart);
const tab = html.slice(tabStart, tabEnd);

const names = [...tab.matchAll(/\bname="([^"]+)"/g)].map(m => m[1]);
check('it still has controls to check', names.length >= 8, `${names.length} found`);

const unread = names.filter(n => !mjs.includes(`get('${n}')`));
check('none of them is wired to nothing', !unread.length, unread.join(', '));

// The six that were inert. Named explicitly so re-adding one without wiring it
// fails here rather than shipping as another dead tick box.
const RETIRED = ['sendPower5s', 'sendPower300s', 'sendPower1200s',
    'sendCP', 'sendPowerCurve', 'sendRouteSuitability'];
const revived = RETIRED.filter(n => names.includes(n));
check('the six dead checkboxes have not come back', !revived.length, revived.join(', '));

// F13: the toggle that said "include" and withheld nothing.
check('there is no watching-athlete opt-out that opts out of nothing',
    !names.includes('includeWatchingAthlete'));

// F15: the tab has to say whose data this is and where it goes.
check('the tab says names always go', /Names always go/.test(tab));
check('and names the destination', /AI Provider<\/strong> tab/.test(tab));

// ---------------------------------------------------------------------------
section('upgrading folds the old power pair into one choice');

const CHILD = `
import { installGlobals, loadAnnouncer } from '${join(REPO, 'scripts/lib/stub-dom.mjs')}';
installGlobals();
const { mod, common: { settingsStore } } = await loadAnnouncer();
for (const [k, v] of Object.entries(JSON.parse(process.env.CASE_SEED || '{}'))) {
    settingsStore.set(k, v);
}
await mod[process.env.CASE_ENTRY]();
process.stdout.write(JSON.stringify({
    powerMode: settingsStore.get('powerMode'),
    // The legacy keys are what a downgrade reads. They must survive untouched.
    sendPower: settingsStore.get('sendPower'),
    sendPower15s: settingsStore.get('sendPower15s')
}));
process.exit(0);
`;

function boot(seed, entry = 'lunaticAnnouncerSettingsMain') {
    const r = spawnSync(process.execPath, ['--input-type=module', '--eval', CHILD], {
        env: { ...process.env, CASE_SEED: JSON.stringify(seed), CASE_ENTRY: entry },
        encoding: 'utf8',
        timeout: 10_000
    });
    if (r.error) return { error: String(r.error.message || r.error) };
    try { return JSON.parse(r.stdout); } catch { return { error: r.stderr || 'no output' }; }
}

// riderLine() read the pair as `if (sendPower15s) … else if (sendPower)`, so
// the 5s box won whenever it was on. The migration has to map what the rider
// actually HEARD, not what the two boxes appeared to say.
let r = boot({ sendPower: true, sendPower15s: true });
check('both ticked (the shipped default) becomes the 5s average',
    r.powerMode === 'smooth5', r.powerMode || r.error);

r = boot({ sendPower: true, sendPower15s: false });
check('only "Current Power" becomes instant', r.powerMode === 'instant', r.powerMode || r.error);

r = boot({ sendPower: false, sendPower15s: true });
check('only "5s rolling" becomes the 5s average', r.powerMode === 'smooth5', r.powerMode || r.error);

r = boot({ sendPower: false, sendPower15s: false });
check('neither becomes off', r.powerMode === 'off', r.powerMode || r.error);

check('and the legacy keys are left exactly as the rider had them',
    r.sendPower === false && r.sendPower15s === false,
    `sendPower=${r.sendPower} sendPower15s=${r.sendPower15s}`);

r = boot({ sendPower: true, sendPower15s: false }, 'lunaticAnnouncerMain');
check('the overlay migrates too — a rider who never opens settings still gets it',
    r.powerMode === 'instant', r.powerMode || r.error);

// Runs once: a later change to powerMode must not be undone by a second boot.
r = boot({ sendPower: true, sendPower15s: true, dataFieldsMigrated: true, powerMode: 'off' });
check('and it runs once, so a later choice survives the next window open',
    r.powerMode === 'off', r.powerMode || r.error);

console.log(bad ? `\n${bad} check(s) failed.` : '\nall checks passed');
process.exit(bad ? 1 : 0);
