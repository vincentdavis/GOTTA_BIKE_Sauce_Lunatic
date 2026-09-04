#!/usr/bin/env node
/**
 * Upgrading, through the real entry points.
 *
 * The storage rules themselves are covered directly in prompt-library-test.mjs.
 * What this checks is the WIRING: that both windows actually run the migration,
 * in an order that leaves the rider on the voice they were using, and that the
 * overlay agrees with the settings window. A rider who never opens settings
 * after upgrading still has to get their own prompt back.
 *
 * One process per case: announcer.mjs migrates at import and holds module-level
 * state, so the stored value has to be in place before the module loads.
 *
 *   node scripts/prompt-migration-test.mjs
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

const CHILD = `
import { installGlobals, loadAnnouncer } from '${join(REPO, 'scripts/lib/stub-dom.mjs')}';
import * as lib from '${join(REPO, 'pages/src/prompt-library.mjs')}';
installGlobals();
const { mod, common: { settingsStore } } = await loadAnnouncer();
for (const [k, v] of Object.entries(JSON.parse(process.env.CASE_SEED || '{}'))) {
    settingsStore.set(k, v);
}
await mod[process.env.CASE_ENTRY]();
const p = lib.resolvePrompt(settingsStore);
process.stdout.write(JSON.stringify({
    id: lib.activeId(settingsStore),
    kind: p.kind,
    name: p.name,
    system: p.systemPrompt.slice(0, 40),
    hosted: lib.hostedStyleFor(settingsStore),
    owned: lib.listUserPrompts(settingsStore).length
}));
process.exit(0);
`;

function boot(seed, entry = 'lunaticAnnouncerSettingsMain') {
    const r = spawnSync(process.execPath, ['--input-type=module', '--eval', CHILD], {
        env: { ...process.env, CASE_SEED: JSON.stringify(seed), CASE_ENTRY: entry },
        encoding: 'utf8',
        // spawnSync waits forever by default, so one wedged child would hang CI
        // with no output. A boot that takes ten seconds is already a failure.
        timeout: 10_000
    });
    if (r.error) return { error: String(r.error.message || r.error) };
    try { return JSON.parse(r.stdout); } catch { return { error: r.stderr || 'no output' }; }
}

let bad = 0;
const check = (n, ok, d = '') => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`);
    if (!ok) bad++;
};
const section = t => console.log(`\n=== ${t} ===`);

section('a rider on a built-in keeps it');
for (const [stored, want] of [
    // The three legacy aliases that all meant Tour de France.
    ['professional', 'tour'], ['casual', 'tour'], ['dramatic', 'tour'],
    ['tour', 'tour'], ['lunatic', 'lunatic'], ['domestique', 'domestique'], ['tactical', 'tactical'],
    // A voice a later build added, then a downgrade.
    ['telemetry-goblin', 'tour'], ['', 'tour']
]) {
    const r = boot(stored ? { stylePreset: stored } : {});
    check(`${JSON.stringify(stored) || "''"} -> ${r.id ?? r.error}`,
        r.id === want && r.kind === 'builtin', r.error || `kind=${r.kind}`);
}

section("a rider's old custom prompt survives the upgrade");
{
    const seed = {
        stylePreset: 'custom',
        customSystemPrompt: 'You are a sarcastic commentator who has seen it all.',
        customUserPrompt: 'Riders:\n{riders}\n\nGo.'
    };
    const r = boot(seed);
    check('it becomes one of their own', r.kind === 'user', r.error || r.kind);
    check('and is what they are on', /^usr-/.test(r.id || ''), r.id);
    check('with their words intact', r.system === 'You are a sarcastic commentator who has ', r.system);
    check('named so they can find it', r.name === 'My prompt', r.name);

    const overlay = boot(seed, 'lunaticAnnouncerMain');
    check('the OVERLAY migrates it too', overlay.kind === 'user' && overlay.system === r.system,
        overlay.error || `${overlay.kind}/${overlay.system}`);
}

section('an old custom selection with nothing in it');
{
    const r = boot({ stylePreset: 'custom', customSystemPrompt: '   ' });
    check('falls back to a real voice', r.id === 'tour' && r.kind === 'builtin', r.error || r.id);
    check('and leaves no empty prompt behind', r.owned === 0, String(r.owned));
}

section('a hosted-only voice choice moves onto the shared key');
for (const [seed, want, why] of [
    [{ hostedStyle: 'lunatic' }, 'lunatic', 'adopted when the shared key is untouched'],
    [{ stylePreset: 'tour', hostedStyle: 'domestique' }, 'domestique', 'the default counts as untouched'],
    [{ stylePreset: 'tactical', hostedStyle: 'lunatic' }, 'tactical', 'a deliberate choice wins'],
    [{ hostedStyle: 'tour' }, 'tour', 'the hosted default changes nothing'],
    [{ hostedStyle: 'telemetry-goblin' }, 'tour', 'an unknown hosted voice is ignored'],
    [{ stylePreset: 'custom', customSystemPrompt: 'mine', hostedStyle: 'lunatic' }, null,
        "a rider's own prompt is never overwritten"]
]) {
    const r = boot(seed);
    const ok = want === null ? r.kind === 'user' : r.id === want;
    check(why, ok, r.error || `got ${r.id} (${r.kind})`);
}

section('the hosted service is always asked for a voice it knows');
for (const [seed, want] of [
    [{ stylePreset: 'domestique' }, 'domestique'],
    [{ stylePreset: 'custom', customSystemPrompt: 'mine' }, 'tour']
]) {
    const r = boot(seed);
    check(`${r.kind} -> style "${r.hosted}"`, r.hosted === want, r.error || '');
}

console.log(bad ? `\n${bad} FAILURE(S)` : '\nall checks passed');
process.exit(bad ? 1 : 0);
