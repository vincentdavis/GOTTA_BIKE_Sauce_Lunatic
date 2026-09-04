#!/usr/bin/env node
/**
 * The prompt library, driven directly.
 *
 * prompt-library.mjs takes the settings store as an argument instead of
 * reaching for Sauce's `common`, so this needs no DOM and no window: it is the
 * storage rules on their own, which is where the mistakes that lose someone's
 * writing would live.
 *
 *   node scripts/prompt-library-test.mjs
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const lib = await import(pathToFileURL(join(REPO, 'pages/src/prompt-library.mjs')).href);
const { BUILTIN_PROMPTS, DEFAULT_PROMPT_ID } = await import(
    pathToFileURL(join(REPO, 'pages/src/prompts.mjs')).href);

let bad = 0;
const check = (n, ok, d = '') => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`);
    if (!ok) bad++;
};
const section = t => console.log(`\n=== ${t} ===`);

/** A settings store with the two methods the library uses. */
const makeStore = (seed = {}) => {
    const m = new Map(Object.entries(seed));
    return { get: k => m.get(k), set: (k, v) => m.set(k, v), _map: m };
};

/** Run fn and return the PromptError message, or null if it did not throw. */
const refusal = fn => {
    try { fn(); return null; } catch (e) { return e instanceof lib.PromptError ? e.message : `WRONG TYPE: ${e}`; }
};

section('a fresh install');
{
    const s = makeStore();
    check('starts on the default voice', lib.activeId(s) === DEFAULT_PROMPT_ID, lib.activeId(s));
    check('with an empty library', lib.listUserPrompts(s).length === 0);
    const p = lib.resolvePrompt(s);
    check('which resolves to a read-only built-in', p.kind === 'builtin' && p.readOnly);
    check('carrying real text', p.systemPrompt === BUILTIN_PROMPTS[DEFAULT_PROMPT_ID].systemPrompt);
}

section('duplicate, edit, save');
{
    const s = makeStore();
    const id = lib.duplicatePrompt(s, 'lunatic');
    check('the copy is a user prompt', lib.isUserPromptId(id), id);
    const copy = lib.resolvePrompt(s, id);
    check('named after its source', copy.name === 'Lunatic (copy)', copy.name);
    check('with the source text', copy.systemPrompt === BUILTIN_PROMPTS.lunatic.systemPrompt);
    check('and it is editable', !copy.readOnly);
    check('provenance recorded', copy.from?.id === 'lunatic' && copy.from.version === 1,
        JSON.stringify(copy.from));

    lib.updatePrompt(s, id, { systemPrompt: 'Shout everything.', name: 'Shouty' });
    const edited = lib.resolvePrompt(s, id);
    check('the edit sticks', edited.systemPrompt === 'Shout everything.');
    check('the rename sticks', edited.name === 'Shouty');
    check('the built-in is untouched', BUILTIN_PROMPTS.lunatic.systemPrompt.startsWith('You are a live'));

    lib.revertToSource(s, id);
    check('reset to source restores the text',
        lib.resolvePrompt(s, id).systemPrompt === BUILTIN_PROMPTS.lunatic.systemPrompt);
    check('but keeps the name', lib.resolvePrompt(s, id).name === 'Shouty');
}

section('a second duplicate keeps pointing at the original built-in');
{
    const s = makeStore();
    const first = lib.duplicatePrompt(s, 'domestique');
    const second = lib.duplicatePrompt(s, first);
    check('the copy of a copy still knows its source',
        lib.resolvePrompt(s, second).from?.id === 'domestique');
    check('and is numbered rather than "(copy) (copy)"',
        lib.resolvePrompt(s, second).name === 'Old Pro (copy 2)',
        lib.resolvePrompt(s, second).name);
}

section('new from blank');
{
    const s = makeStore();
    const id = lib.newBlankPrompt(s);
    const p = lib.resolvePrompt(s, id);
    check('has no source', p.from === null);
    check('starts with something to replace, not an empty box', p.systemPrompt.length > 20);
    check('and a working user template', p.userPromptTemplate.includes('{riders}'));
    check('reset to source is refused',
        refusal(() => lib.revertToSource(s, id))?.includes('written from scratch'),
        refusal(() => lib.revertToSource(s, id)));
    const second = lib.newBlankPrompt(s);
    check('a second blank gets its own name',
        lib.resolvePrompt(s, second).name === 'My prompt 2', lib.resolvePrompt(s, second).name);
}

section('what the rider cannot do');
{
    const s = makeStore();
    const id = lib.duplicatePrompt(s, 'tour');
    check('an empty name is refused',
        refusal(() => lib.updatePrompt(s, id, { name: '   ' }))?.includes('name'));
    check('an empty system message is refused',
        refusal(() => lib.updatePrompt(s, id, { systemPrompt: '' }))?.includes('cannot be empty'));
    check('an over-long system message is refused',
        refusal(() => lib.updatePrompt(s, id, { systemPrompt: 'x'.repeat(lib.MAX_PROMPT_CHARS + 1) }))
            ?.includes('too long'));
    check('exactly at the limit is allowed',
        refusal(() => lib.updatePrompt(s, id, { systemPrompt: 'x'.repeat(lib.MAX_PROMPT_CHARS) })) === null);

    const other = lib.newBlankPrompt(s);
    check('a duplicate name is refused',
        refusal(() => lib.updatePrompt(s, other, { name: lib.resolvePrompt(s, id).name }))
            ?.includes('already have'));
    check('renaming to its own name is fine',
        refusal(() => lib.updatePrompt(s, other, { name: 'My prompt' })) === null);

    while (lib.listUserPrompts(s).length < lib.MAX_USER_PROMPTS) lib.newBlankPrompt(s);
    check(`the ${lib.MAX_USER_PROMPTS}-prompt cap is enforced`,
        refusal(() => lib.newBlankPrompt(s))?.includes('limit'));
    check('with a message that says what to do',
        refusal(() => lib.newBlankPrompt(s))?.includes('Delete one'));
}

section('delete');
{
    const s = makeStore();
    const a = lib.duplicatePrompt(s, 'tour');
    const b = lib.duplicatePrompt(s, 'lunatic');
    lib.setActive(s, b);
    const next = lib.deletePrompt(s, b);
    check('deleting the active one moves to another of yours', next === a, next);
    check('and the active setting followed', lib.activeId(s) === a);
    const last = lib.deletePrompt(s, a);
    check('deleting the last one falls back to a built-in', last === DEFAULT_PROMPT_ID, last);
    check('deleting something gone is refused',
        refusal(() => lib.deletePrompt(s, a))?.includes('no longer exists'));
}

section('deleting one you are not on leaves the active voice alone');
{
    const s = makeStore();
    const keep = lib.duplicatePrompt(s, 'tour');
    const drop = lib.duplicatePrompt(s, 'lunatic');
    lib.setActive(s, keep);
    lib.deletePrompt(s, drop);
    check('still on the one you were using', lib.activeId(s) === keep);
}

section('the hosted service is asked for a voice it knows');
{
    const s = makeStore();
    check('a built-in asks for itself', lib.hostedStyleFor(s, 'domestique') === 'domestique');
    const copy = lib.duplicatePrompt(s, 'lunatic');
    check('a copy asks for what it came from', lib.hostedStyleFor(s, copy) === 'lunatic');
    const blank = lib.newBlankPrompt(s);
    check('one written from scratch asks for the default',
        lib.hostedStyleFor(s, blank) === DEFAULT_PROMPT_ID);
    check('never a usr- id', !lib.isUserPromptId(lib.hostedStyleFor(s, copy)));
}

section('a settings bag that has been through the wars');
{
    for (const [label, seed] of [
        ['no library at all', {}],
        ['library is a string', { promptLibrary: 'nonsense' }],
        ['items is null', { promptLibrary: { items: null } }],
        ['an entry is null', { promptLibrary: { items: { 'usr-abc123': null } } }],
        ['an id that is not ours', { promptLibrary: { items: { 'tour': { name: 'x' } } } }],
        ['provenance to a voice that no longer exists',
            { promptLibrary: { items: { 'usr-abc123': { name: 'x', systemPrompt: 'y', from: { id: 'gone' } } } } }]
    ]) {
        const s = makeStore(seed);
        let err = null;
        try {
            lib.listUserPrompts(s);
            lib.activeId(s);
            lib.resolvePrompt(s);
        } catch (e) { err = e; }
        check(label, !err, err ? String(err) : '');
    }
    const s = makeStore({ promptLibrary: { items: { 'usr-abc123': { name: 'x', systemPrompt: 'y', from: { id: 'gone' } } } } });
    check('the dead provenance is dropped, not kept', lib.resolvePrompt(s, 'usr-abc123').from === null);
}

section('the active setting cannot point at nothing');
{
    check('an unknown id falls back', lib.activeId(makeStore({ stylePreset: 'telemetry-goblin' })) === DEFAULT_PROMPT_ID);
    check('a deleted user id falls back', lib.activeId(makeStore({ stylePreset: 'usr-zzzzzz' })) === DEFAULT_PROMPT_ID);
    check('a real built-in is kept', lib.activeId(makeStore({ stylePreset: 'lunatic' })) === 'lunatic');
}

section('migrating the old single custom slot');
{
    const s = makeStore({
        stylePreset: 'custom',
        customSystemPrompt: 'You are a sarcastic commentator.',
        customUserPrompt: 'Riders:\n{riders}\n\nGo.'
    });
    const id = lib.migratePrompts(s);
    check('it becomes a library prompt', lib.isUserPromptId(id), String(id));
    check('and is made active', lib.activeId(s) === id);
    const p = lib.resolvePrompt(s, id);
    check('with the text preserved', p.systemPrompt === 'You are a sarcastic commentator.');
    check('and the template preserved', p.userPromptTemplate === 'Riders:\n{riders}\n\nGo.');
    check('the legacy keys are left in place for a downgrade',
        s.get('customSystemPrompt') === 'You are a sarcastic commentator.');

    check('running again does nothing', lib.migratePrompts(s) === null);
    check('and does not duplicate', lib.listUserPrompts(s).length === 1);

    lib.deletePrompt(s, id);
    lib.migratePrompts(s);
    check('a deleted migrated prompt does not come back', lib.listUserPrompts(s).length === 0);
}

section('migrating when there was nothing to migrate');
{
    const s = makeStore({ stylePreset: 'custom', customSystemPrompt: '   ' });
    check('returns nothing', lib.migratePrompts(s) === null);
    check('and moves off the dead selection', lib.activeId(s) === DEFAULT_PROMPT_ID);

    const t = makeStore({ stylePreset: 'lunatic', customSystemPrompt: 'kept' });
    lib.migratePrompts(t);
    check('a rider who was on a built-in keeps it', lib.activeId(t) === 'lunatic');
    check('but their old text is still recovered', lib.listUserPrompts(t).length === 1);
}

section('legacy voice ids, folded into the same one-shot migration');
{
    for (const [stored, want] of [
        ['professional', 'tour'], ['casual', 'tour'], ['dramatic', 'tour'],
        ['lunatic', 'lunatic'], ['tactical', 'tactical'], ['telemetry-goblin', 'tour']
    ]) {
        const s = makeStore({ stylePreset: stored });
        lib.migratePrompts(s);
        check(`${stored} -> ${lib.activeId(s)}`, lib.activeId(s) === want);
    }
}

section('the old hosted-only voice choice');
{
    for (const [preset, hosted, want, why] of [
        ['', 'lunatic', 'lunatic', 'adopted when the shared key is untouched'],
        ['tour', 'domestique', 'domestique', 'the default counts as untouched'],
        ['tactical', 'lunatic', 'tactical', 'a deliberate choice wins'],
        ['', 'telemetry-goblin', 'tour', 'an unknown hosted voice is ignored']
    ]) {
        const s = makeStore(preset ? { stylePreset: preset, hostedStyle: hosted } : { hostedStyle: hosted });
        lib.migratePrompts(s);
        check(why, lib.activeId(s) === want, `got ${lib.activeId(s)}, wanted ${want}`);
    }

    // The bug this consolidation fixes: it used to run on EVERY window open, so
    // a rider who later set their voice back to the default had the old hosted
    // choice silently reimposed.
    const s = makeStore({ hostedStyle: 'lunatic' });
    lib.migratePrompts(s);
    lib.setActive(s, DEFAULT_PROMPT_ID);
    lib.migratePrompts(s);
    check('it never fires a second time', lib.activeId(s) === DEFAULT_PROMPT_ID, lib.activeId(s));
}

console.log(bad ? `\n${bad} FAILURE(S)` : '\nall checks passed');
process.exit(bad ? 1 : 0);
