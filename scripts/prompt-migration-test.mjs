#!/usr/bin/env node
/**
 * Legacy `stylePreset` values must land on the voice the rider was already
 * hearing, not on whatever happens to be first in the table.
 *
 * Before the sets were reconciled, 'professional', 'casual' and 'dramatic' were
 * three stored values all aliased to the same Tour de France prompt, and the
 * dropdown only ever offered the third. Anyone who picked a style before that
 * aliasing landed still has one of the other two in their settings bag.
 *
 * One process per case: announcer.mjs migrates at import, so the stored value
 * has to be in place before the module loads.
 *
 *   node scripts/prompt-migration-test.mjs
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

// [stored stylePreset, expected after migration]
const CASES = [
    ['professional', 'tour'],
    ['casual', 'tour'],
    ['dramatic', 'tour'],
    ['tour', 'tour'],
    ['lunatic', 'lunatic'],
    ['domestique', 'domestique'],
    ['tactical', 'tactical'],
    ['custom', 'custom'],
    // A voice a later build added, then a downgrade. Must not leave the picker
    // on a value matching no option.
    ['telemetry-goblin', 'tour'],
    ['', 'tour']
];

const CHILD = `
import { installGlobals, loadAnnouncer } from '${join(REPO, 'scripts/lib/stub-dom.mjs')}';
installGlobals();
const { mod, common: { settingsStore } } = await loadAnnouncer();
if (process.env.CASE_VALUE) settingsStore.set('stylePreset', process.env.CASE_VALUE);
if (process.env.CASE_HOSTED) settingsStore.set('hostedStyle', process.env.CASE_HOSTED);
await mod.lunaticAnnouncerSettingsMain();
process.stdout.write(String(settingsStore.get('stylePreset')));
process.exit(0);
`;

function run(stored, hosted) {
    const r = spawnSync(process.execPath, ['--input-type=module', '--eval', CHILD], {
        env: { ...process.env, CASE_VALUE: stored || '', CASE_HOSTED: hosted || '' },
        encoding: 'utf8'
    });
    return { got: (r.stdout || '').trim(), stderr: r.stderr };
}

let bad = 0;
console.log('\n=== stored voice ids survive the reconcile ===');
for (const [stored, want] of CASES) {
    const { got, stderr } = run(stored);
    const ok = got === want;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${JSON.stringify(stored) || "''"} -> ${got || '(nothing)'}` +
        (ok ? '' : `  — expected ${want}${stderr ? '\n' + stderr.trim() : ''}`));
    if (!ok) bad++;
}

// `hostedStyle` was a second voice picker on the AI Provider tab. Now that both
// settings name the same voices, a hosted-only choice has to move onto the
// shared key -- but never over a deliberate one.
console.log('\n=== a hosted-only voice choice moves onto the shared key ===');
for (const [stored, hosted, want, why] of [
    ['', 'lunatic', 'lunatic', 'hosted choice adopted when the shared key is untouched'],
    ['tour', 'domestique', 'domestique', 'default on the shared key still counts as untouched'],
    ['tactical', 'lunatic', 'tactical', 'a deliberate shared choice wins'],
    ['custom', 'lunatic', 'custom', "a rider's own prompts are not overwritten"],
    ['', 'tour', 'tour', 'hosted default changes nothing'],
    ['', 'telemetry-goblin', 'tour', 'an unknown hosted voice is ignored']
]) {
    const { got, stderr } = run(stored, hosted);
    const ok = got === want;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${why}` +
        (ok ? '' : `  — got ${got || '(nothing)'}, expected ${want}${stderr ? '\n' + stderr.trim() : ''}`));
    if (!ok) bad++;
}

console.log(bad ? `\n${bad} FAILURE(S)` : '\nall checks passed');
process.exit(bad ? 1 : 0);
