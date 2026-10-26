#!/usr/bin/env node
/**
 * The account requirement for your own API key, and the dead end it almost was.
 *
 * Anthropic and OpenAI-compatible need a Lunatic account. That is a deliberate
 * product decision -- but it is only a gate on a service that can actually mint
 * an account. A self-hosted deployment with no Discord app configured, and ours
 * with its storage down, both answer /v1/pair/start with 503
 * `accounts_unavailable`: there is no sign-in to complete, so a rider was
 * locked to the hosted models, which that deployment may not have configured
 * either. Nothing to pick, and nothing on screen saying why.
 *
 * So the mod asks /healthz (which has always reported it) while the answer
 * matters, and unlocks the own-key providers when the answer is no. The two
 * directions that matter are both here: a service that CAN do accounts must
 * keep the gate, and an unreachable one must fail CLOSED -- failing open would
 * hand the unlock to anyone who opened settings while offline.
 *
 * One process per case: announcer.mjs holds module-level state and migrates at
 * import, and each case needs a different answer from the network.
 *
 *   node scripts/byok-gate-test.mjs
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

let bad = 0;
const check = (n, ok, d = '') => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`);
    if (!ok) bad++;
};
const section = t => console.log(`\n=== ${t} ===`);

const SERVICE = 'https://lunatic.example';

const CHILD = `
import { installGlobals, loadAnnouncer, makeEl, el } from '${join(REPO, 'scripts/lib/stub-dom.mjs')}';
installGlobals();
const { mod, common: { settingsStore } } = await loadAnnouncer();

// The stub does not parse <option>s out of the HTML, and the whole gate is
// renderByokLock() disabling two of them.
for (const value of ['hosted', 'anthropic', 'compatible']) {
    const opt = makeEl('option');
    opt.value = value;
    document.querySelector('select[name="aiProvider"]').children.push(opt);
}

for (const [k, v] of Object.entries(JSON.parse(process.env.CASE_SEED || '{}'))) {
    settingsStore.set(k, v);
}

// What this deployment's /healthz answers. installGlobals() has already put a
// throwing fetch in place; this replaces it before the entry point runs.
const HEALTH = process.env.CASE_HEALTH;
let healthzCalls = 0;
globalThis.fetch = async url => {
    if (!String(url).endsWith('/healthz')) throw new Error('no network in this test');
    healthzCalls++;
    if (HEALTH === 'unreachable') throw new Error('service unreachable');
    return { ok: true, status: 200, json: async () => JSON.parse(HEALTH) };
};

await mod.lunaticAnnouncerSettingsMain();
// The probe is deliberately NOT awaited -- the window has to finish wiring
// whatever the network does. Give it its turns.
await new Promise(r => setTimeout(r, 50));

const sel = document.querySelector('select[name="aiProvider"]');
const opt = v => sel.children.find(o => o.value === v);
process.stdout.write(JSON.stringify({
    healthzCalls,
    locked: opt('anthropic').disabled === true && opt('compatible').disabled === true,
    hostedLocked: opt('hosted').disabled === true,
    noteShown: el('byok-locked').hidden === false,
    bulletShown: el('account-pitch-byok').hidden === false,
    finding: settingsStore.get('serviceWithoutAccounts') || null
}));
process.exit(0);
`;

function boot({ health = '{"ok":true,"accounts":"ready"}', seed = {} } = {}) {
    const r = spawnSync(process.execPath, ['--input-type=module', '--eval', CHILD], {
        env: {
            ...process.env,
            CASE_HEALTH: health,
            CASE_SEED: JSON.stringify({ hostedBaseUrl: SERVICE, ...seed })
        },
        encoding: 'utf8',
        timeout: 15_000
    });
    if (r.error) return { error: String(r.error.message || r.error) };
    try { return JSON.parse(r.stdout); } catch { return { error: r.stderr || 'no output' }; }
}

// ---------------------------------------------------------------------------
section('a service that can sign riders in keeps the requirement');
let r = boot();
check('your own key still needs an account', r.locked === true, r.error);
check('the free option is never locked', r.hostedLocked === false, r.error);
check('and the reason is on screen', r.noteShown === true);
check('the Account tab still offers the unlock as a benefit', r.bulletShown === true);
check('nothing is remembered about it', r.finding === null, JSON.stringify(r.finding));

// ---------------------------------------------------------------------------
section('a service with no Discord app is not a dead end');
r = boot({ health: '{"ok":true,"accounts":"not-configured"}' });
check('the own-key providers are available', r.locked === false, r.error);
check('the lock note is gone with them', r.noteShown === false);
check('and the tab stops promising a sign-in that would 503',
    r.bulletShown === false);
check('the finding names the service it was made at',
    r.finding?.url === SERVICE, JSON.stringify(r.finding));
check('and why', r.finding?.reason === 'not-configured', JSON.stringify(r.finding));

// Our own service, mid storage outage. /v1/pair/start refuses this too, because
// losing an ACCOUNT means a rider's key stops working with no way back.
section('...nor is ours with its storage down');
r = boot({ health: '{"ok":true,"accounts":"blocked-no-durable-storage"}' });
check('the own-key providers are available', r.locked === false, r.error);
check('recorded as the outage it is',
    r.finding?.reason === 'blocked-no-durable-storage', JSON.stringify(r.finding));

// ---------------------------------------------------------------------------
section('an answer it did not get is not a no');
r = boot({ health: 'unreachable' });
check('an unreachable service fails CLOSED', r.locked === true, r.error);
check('and records nothing', r.finding === null, JSON.stringify(r.finding));

// A deployment from before /healthz reported the field at all.
r = boot({ health: '{"ok":true,"durableStorage":true}' });
check('a deployment too old to say also fails closed', r.locked === true, r.error);
check('absence is not an answer', r.finding === null, JSON.stringify(r.finding));

// ---------------------------------------------------------------------------
section('a stale finding does not outlive the service it was made at');
// Recorded somewhere else, and this service cannot be reached to correct it.
r = boot({ health: 'unreachable',
           seed: { serviceWithoutAccounts: { url: 'https://elsewhere.example',
                                             reason: 'not-configured' } } });
check('an unlock found elsewhere does not travel', r.locked === true, r.error);

// The deployment has since been given a Discord app.
r = boot({ seed: { serviceWithoutAccounts: { url: SERVICE, reason: 'not-configured' } } });
check('and one the service has outgrown is dropped', r.locked === true, r.error);
check('with the finding cleared', !r.finding, JSON.stringify(r.finding));

// ---------------------------------------------------------------------------
section('a rider who is not waiting on the answer is not asked about');
r = boot({ seed: { '/gotta-bike-lunatic-device-token': 'luna_discord_account_key' } });
check('signed in with Discord unlocks it', r.locked === false, r.error);
check('and the service is not asked', r.healthzCalls === 0, `${r.healthzCalls} call(s)`);

r = boot({ seed: { claudeApiKey: 'sk-ant-api03-already-theirs' } });
check('a key stored before the requirement keeps its provider',
    r.locked === false, r.error);
check('and the service is not asked about that either',
    r.healthzCalls === 0, `${r.healthzCalls} call(s)`);

console.log(bad ? `\n${bad} check(s) failed.` : '\nall checks passed');
process.exit(bad ? 1 : 0);
