#!/usr/bin/env node
/**
 * The line diff, and the "what changed" data behind it.
 *
 * Pure functions, so they are driven directly. The parts worth being sure of
 * are the ones a person reads: that a change is actually shown, that the
 * unchanged forty lines around it are not, and that "your copy is behind"
 * fires exactly when it should and never on a copy that is current.
 *
 *   node scripts/prompt-diff-test.mjs
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const load = rel => import(pathToFileURL(join(REPO, rel)).href);

const d = await load('pages/src/prompt-diff.mjs');
const lib = await load('pages/src/prompt-library.mjs');
const { BUILTIN_PROMPTS } = await load('pages/src/prompts.mjs');

let bad = 0;
const check = (n, ok, detail = '') => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${detail ? ' — ' + detail : ''}`);
    if (!ok) bad++;
};
const section = t => console.log(`\n=== ${t} ===`);

const makeStore = (seed = {}) => {
    const m = new Map(Object.entries(seed));
    return { get: k => m.get(k), set: (k, v) => m.set(k, v) };
};
const types = h => h.map(x => x.type).join(' ');
const texts = (h, t) => h.filter(x => x.type === t).map(x => x.text);

section('the shape of a diff');
{
    check('identical text has no changes',
        d.diffLines('a\nb\nc', 'a\nb\nc').every(h => h.type === 'same'));

    const one = d.diffLines('a\nb\nc', 'a\nB\nc');
    check('one changed line is a del then an add', types(one) === 'same del add same', types(one));
    check('carrying the old text', texts(one, 'del')[0] === 'b');
    check('and the new', texts(one, 'add')[0] === 'B');

    const ins = d.diffLines('a\nc', 'a\nb\nc');
    check('a pure insertion has no deletion', types(ins) === 'same add same', types(ins));

    const del = d.diffLines('a\nb\nc', 'a\nc');
    check('a pure deletion has no addition', types(del) === 'same del same', types(del));

    check('empty to something is all additions',
        d.diffLines('', 'a\nb').filter(h => h.type === 'add').length === 2);
    check('something to empty is all deletions',
        d.diffLines('a\nb', '').filter(h => h.type === 'del').length === 2);
    check('null is survivable', Array.isArray(d.diffLines(null, undefined)));
}

section('a moved line is not reported as rewritten');
{
    // The LCS matters here: a naive line-by-line compare would call every line
    // after an insertion "changed", which is unreadable on a numbered rule list.
    const before = ['1. one', '2. two', '3. three', '4. four'].join('\n');
    const after = ['1. one', '1a. inserted', '2. two', '3. three', '4. four'].join('\n');
    const h = d.diffLines(before, after);
    check('only the inserted line is new', texts(h, 'add').length === 1, texts(h, 'add').join('|'));
    check('and nothing is reported deleted', texts(h, 'del').length === 0);
}

section('the unchanged middle is collapsed away');
{
    const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    const after = before.replace('line 20', 'line 20 CHANGED');
    const full = d.diffLines(before, after);
    const small = d.collapse(full, 2);
    check('the full diff is long', full.length >= 41, String(full.length));
    check('the collapsed one is short', small.length <= 9, String(small.length));
    check('the change survives', small.some(h => h.type === 'add' && h.text.includes('CHANGED')));
    check('with context either side', small.filter(h => h.type === 'same').length >= 4);
    check('and the elision is visible', small.some(h => h.type === 'gap'), types(small));
    const gaps = small.filter(h => h.type === 'gap').reduce((n, g) => n + g.count, 0);
    check('gaps account for every hidden line', gaps === full.length - small.filter(h => h.type !== 'gap').length,
        `${gaps} hidden`);

    // A single skipped line is shown rather than described: "1 line hidden"
    // is longer than the line.
    const twoChanges = d.collapse(d.diffLines('a\nb\nc\nd\ne', 'A\nb\nc\nd\nE'), 1);
    check('a one-line gap is not worth a marker', !twoChanges.some(h => h.type === 'gap'),
        types(twoChanges));
}

section('diffing two prompts');
{
    const before = { systemPrompt: 'one\ntwo', userPromptTemplate: '{riders}' };
    const after = { systemPrompt: 'one\nTWO', userPromptTemplate: '{riders}' };
    const parts = d.diffPrompts(before, after);
    check('only the field that changed is reported', parts.length === 1, String(parts.length));
    check('and it is named', parts[0].label === 'System message', parts[0].label);
    check('with counts', parts[0].added === 1 && parts[0].removed === 1);
    check('an identical pair reports nothing', d.diffPrompts(before, before).length === 0);
}

section('a real prompt, really changed');
{
    const before = BUILTIN_PROMPTS.tour;
    const after = {
        ...before,
        systemPrompt: before.systemPrompt.replace('One sentence, occasionally two. Never more.',
            'One sentence. Never two.')
    };
    const parts = d.diffPrompts(before, after);
    check('the rewritten rule is found', parts.length === 1);
    check('exactly one line each way', parts[0].added === 1 && parts[0].removed === 1,
        `+${parts[0].added} -${parts[0].removed}`);
    check('and the view is small', parts[0].hunks.length <= 8, String(parts[0].hunks.length));
}

section('a copy that is behind its source');
{
    const s = makeStore();
    const mine = lib.duplicatePrompt(s, 'lunatic');
    check('a fresh copy is not behind', lib.staleCopies(s).length === 0);

    s.set('builtinPrompts', {
        revision: 'r2',
        fetchedAt: Date.now(),
        data: [{ ...BUILTIN_PROMPTS.lunatic, id: 'lunatic', version: 3,
                 systemPrompt: 'Rewritten entirely.' }]
    });
    const stale = lib.staleCopies(s);
    check('now it is', stale.length === 1, JSON.stringify(stale));
    check('naming the copy', stale[0].name === 'Lunatic (copy)', stale[0].name);
    check('and the version step', stale[0].had === 1 && stale[0].now === 3);
    check('the copy itself is untouched',
        lib.resolvePrompt(s, mine).systemPrompt === BUILTIN_PROMPTS.lunatic.systemPrompt);

    // The diff a rider actually wants here: theirs against the current source.
    const parts = d.diffPrompts(lib.resolvePrompt(s, mine), lib.builtinFor(s, 'lunatic'));
    check('and there is something to show them', parts.length >= 1);

    lib.revertToSource(s, mine);
    check('resetting clears it', lib.staleCopies(s).length === 0);
}

section('what is NOT reported as behind');
{
    const s = makeStore();
    lib.newBlankPrompt(s);
    check('a prompt written from scratch has no source', lib.staleCopies(s).length === 0);

    const t = makeStore();
    const c = lib.duplicatePrompt(t, 'tour');
    t.set('builtinPrompts', {
        revision: 'gone', fetchedAt: Date.now(),
        data: [{ ...BUILTIN_PROMPTS.lunatic, id: 'lunatic', version: 1 }]
    });
    check('a copy of a voice the service dropped is not "behind"',
        lib.staleCopies(t).length === 0, JSON.stringify(lib.staleCopies(t)));
    check('because the bundled source is still at the version they copied',
        lib.builtinFor(t, 'tour').version === 1);
}

section('the previous text kept for the diff');
{
    const s = makeStore({
        builtinPrompts: {
            revision: 'r2', fetchedAt: Date.now(),
            data: [{ ...BUILTIN_PROMPTS.tour, id: 'tour', version: 2, systemPrompt: 'New words.' }],
            previous: { tour: { version: 1, systemPrompt: 'Old words.', userPromptTemplate: '{riders}' } }
        }
    });
    check('it is readable', lib.previousBuiltin(s, 'tour')?.systemPrompt === 'Old words.');
    check('and only for what changed', lib.previousBuiltin(s, 'lunatic') === null);
    const parts = d.diffPrompts(lib.previousBuiltin(s, 'tour'), lib.builtinFor(s, 'tour'));
    check('so the notice can show a real diff', parts.length >= 1,
        JSON.stringify(parts.map(p => p.label)));
}

console.log(bad ? `\n${bad} FAILURE(S)` : '\nall checks passed');
process.exit(bad ? 1 : 0);
