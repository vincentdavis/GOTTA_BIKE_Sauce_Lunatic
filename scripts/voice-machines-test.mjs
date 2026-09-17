#!/usr/bin/env node
/**
 * The mod on a machine that is not the author's Mac.
 *
 * listVoices() filtered `/^en/i` and nothing else. On a Windows install whose
 * display language is not English, that returns an empty list: pickVoice()
 * gives null, speech never happens, and there is nothing on screen to say why.
 * The settings window was worse than silent -- populateVoicePicker() was
 * awaited ahead of every other setup call, so a machine with no ready voices
 * left the whole window unwired for a 3 second timeout and then showed an empty
 * dropdown.
 *
 * One process per machine: announcer.mjs holds module state and the voice list
 * has to be in place before it loads.
 *
 *   node scripts/voice-machines-test.mjs
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

const CHILD = `
import { installGlobals, loadAnnouncer, el, fire } from '${join(REPO, 'scripts/lib/stub-dom.mjs')}';
installGlobals({ voices: JSON.parse(process.env.CASE_VOICES) });
const { mod } = await loadAnnouncer();
const t0 = Date.now();
await mod.lunaticAnnouncerSettingsMain();
const bootMs = Date.now() - t0;
// The picker gives voices up to 3s to arrive -- they do arrive late in a real
// browser. WAIT_MS lets one case see the verdict it settles on.
if (process.env.CASE_WAIT) await new Promise(r => setTimeout(r, Number(process.env.CASE_WAIT)));
fire(el('test-voice-btn'), 'click');
await new Promise(r => setImmediate(r));
const picker = el('tts-voice');
process.stdout.write(JSON.stringify({
    bootMs,
    // What the Speaking voice dropdown offers, and what it landed on.
    options: picker.children.map(o => o.textContent),
    disabled: picker.children.map(o => !!o.disabled),
    selected: picker.value,
    spokenVoice: speechSynthesis.spoken[0]?.voice?.name ?? null,
    spokenCount: speechSynthesis.spoken.length,
    status: el('voice-test-status').textContent,
    statusClass: el('voice-test-status').className,
    // Boot has to finish wiring the rest of the window whatever the voices do.
    tabsWired: !!el('setup-nudge').hidden === false || true,
    providerRowsDone: el('api-status-text').textContent
}));
process.exit(0);
`;

function boot(voices, waitMs = 0) {
    const r = spawnSync(process.execPath, ['--input-type=module', '--eval', CHILD], {
        env: { ...process.env, CASE_VOICES: JSON.stringify(voices), CASE_WAIT: String(waitMs || '') },
        encoding: 'utf8',
        timeout: 15_000
    });
    if (r.error) return { error: String(r.error.message || r.error) };
    try { return JSON.parse(r.stdout); } catch { return { error: r.stderr || 'no output' }; }
}

const v = (name, lang) => ({ name, lang, default: false, localService: true });

// ---------------------------------------------------------------------------
section('Windows, English');
// The names Windows actually ships. None of them is Daniel or Samantha, so this
// used to fall through to voices[0] -- whatever getVoices() returned first.
let r = boot([v('Microsoft Zira - English (United States)', 'en-US'),
              v('Microsoft David - English (United States)', 'en-US'),
              v('Microsoft Hazel - English (Great Britain)', 'en-GB')]);
check('the picker is filled', r.options?.length === 3, (r.options || []).join(' | ') || r.error);
check('it lands on a named preference, not just the first',
    r.selected?.startsWith('Microsoft David'), r.selected || r.error);
check('Test Voice speaks on it', r.spokenVoice?.startsWith('Microsoft David'),
    String(r.spokenVoice));

// ---------------------------------------------------------------------------
section('Windows, no English voices at all');
// A German install. The old /^en/ filter emptied the list here and speech was
// dead with nothing said about it.
r = boot([v('Microsoft Hedda - German (Germany)', 'de-DE'),
          v('Microsoft Stefan - German (Germany)', 'de-DE')]);
check('the voices it has are offered rather than none', r.options?.length === 2,
    (r.options || []).join(' | ') || r.error);
check('and one is selected', !!r.selected, r.selected || '(none)');
check('Test Voice speaks instead of doing nothing', r.spokenCount === 1,
    `${r.spokenCount} utterance(s)`);

// ---------------------------------------------------------------------------
section('a machine with no voices installed');
r = boot([]);
// Not "No voices found" yet: getVoices() is legitimately empty for the first
// moments in a browser. An unexplained empty dropdown is still never right.
check('the dropdown says what is happening rather than sitting empty',
    /Looking for voices/.test((r.options || []).join(' ')), (r.options || []).join(' | ') || r.error);
check('and that entry cannot be chosen', r.disabled?.[0] === true, JSON.stringify(r.disabled));
check('Test Voice reports it', /No voices found/.test(r.status || ''), r.status || '(blank)');
check('as an error, not as a result', r.statusClass === 'error', r.statusClass);
check('and nothing is spoken', r.spokenCount === 0, `${r.spokenCount} utterance(s)`);

// The reason this one matters: the empty list used to block the whole window.
check('the window still boots promptly', r.bootMs < 3000, `${r.bootMs}ms`);
check('and the rest of it is wired', !!r.providerRowsDone, r.providerRowsDone || '(nothing rendered)');

// Once they have not arrived, it stops waiting and says so. The one slow case
// here, because 3s is the timeout it is waiting out.
r = boot([], 3300);
check('and once they are not coming, it says so',
    /No voices found/.test((r.options || []).join(' ')), (r.options || []).join(' | ') || r.error);
check('still unselectable', r.disabled?.[0] === true, JSON.stringify(r.disabled));

console.log(bad ? `\n${bad} check(s) failed.` : '\nall checks passed');
process.exit(bad ? 1 : 0);
