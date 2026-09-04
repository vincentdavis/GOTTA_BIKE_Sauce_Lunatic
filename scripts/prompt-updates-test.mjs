#!/usr/bin/env node
/**
 * The mod's update check, against the real service.
 *
 * Not a mocked fetch: this boots service/src/index.mjs's actual /v1/prompts
 * handler over a real socket and drives the mod's own prompt-updates.mjs at it.
 * The two halves of an ETag round trip are written in different files by
 * different rules, and a mock would only ever prove that I wrote the mock to
 * match what I wrote.
 *
 *   node scripts/prompt-updates-test.mjs
 */
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const load = rel => import(pathToFileURL(join(REPO, rel)).href);

const updates = await load('pages/src/prompt-updates.mjs');
const lib = await load('pages/src/prompt-library.mjs');
const { BUILTIN_PROMPTS } = await load('pages/src/prompts.mjs');
const styles = await load('service/src/styles.mjs');

let bad = 0;
const check = (n, ok, d = '') => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`);
    if (!ok) bad++;
};
const section = t => console.log(`\n=== ${t} ===`);

// ---------------------------------------------------------------------------
// A stand-in for the service that reuses its real prompt table and ETag logic,
// so the wire format under test is the one the service actually serves.
// ---------------------------------------------------------------------------
let served = { table: null, status: 200, body: null, requests: [] };

const server = createServer((req, res) => {
    served.requests.push({ url: req.url, headers: { ...req.headers } });
    if (served.status !== 200) {
        res.writeHead(served.status, { 'Content-Type': 'application/json' });
        return res.end(served.body ?? '{}');
    }
    if (served.body !== null) {
        res.writeHead(200, { 'Content-Type': 'application/json', ETag: '"custom"' });
        return res.end(served.body);
    }
    const data = served.table ?? styles.listPromptDefinitions();
    const revision = served.revision ?? styles.promptsRevision();
    const etag = `"${revision}"`;
    const seen = String(req.headers['if-none-match'] || '')
        .split(',').map(v => v.trim().replace(/^W\//, ''));
    if (seen.includes(etag)) {
        res.writeHead(304, { ETag: etag });
        return res.end();
    }
    const payload = JSON.stringify({ object: 'list', revision, default: 'tour', data });
    res.writeHead(200, { 'Content-Type': 'application/json', ETag: etag });
    res.end(payload);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const makeStore = (seed = {}) => {
    const m = new Map(Object.entries({ hostedBaseUrl: BASE, ...seed }));
    return { get: k => m.get(k), set: (k, v) => m.set(k, v) };
};
const reset = () => { served = { table: null, status: 200, body: null, requests: [] }; };

// ---------------------------------------------------------------------------
section('a first check picks up the service copy');
{
    reset();
    const s = makeStore();
    const r = await updates.checkForUpdates(s);
    check('it reports no change on a matching table', r.status === 'unchanged', JSON.stringify(r));
    check('and cached what it got', !!lib.readCache(s));
    check('with the service revision', lib.readCache(s).revision === styles.promptsRevision());
    check('the request carries no query string', !served.requests[0].url.includes('?'),
        served.requests[0].url);
    for (const h of ['authorization', 'cookie', 'x-lunatic-athlete']) {
        check(`and no ${h} header`, !(h in served.requests[0].headers));
    }
}

section('the second check is conditional, and cheap');
{
    reset();
    const s = makeStore();
    await updates.checkForUpdates(s);
    const r = await updates.checkForUpdates(s, { force: true });
    check('it sends If-None-Match', !!served.requests[1]?.headers['if-none-match'],
        served.requests[1]?.headers['if-none-match']);
    check('the service answers 304', r.status === 'unchanged');
    check('and the cache survives', !!lib.readCache(s));
}

section('an improved voice');
{
    reset();
    const s = makeStore();
    await updates.checkForUpdates(s);

    served.table = styles.listPromptDefinitions().map(p => p.id === 'lunatic'
        ? { ...p, version: 2, systemPrompt: p.systemPrompt + '\n10. Even louder.',
            changelog: 'Louder.' }
        : p);
    served.revision = 'deadbeef';

    const r = await updates.checkForUpdates(s, { force: true });
    check('it is reported as updated', r.status === 'updated', JSON.stringify(r.status));
    check('naming the voice', r.updated?.[0]?.label === 'Lunatic', JSON.stringify(r.updated));
    check('with the version step', r.updated[0].from === 1 && r.updated[0].to === 2);
    check('and the changelog', r.updated[0].changelog === 'Louder.');

    check('the merged table has the new text',
        lib.builtins(s).lunatic.systemPrompt.endsWith('10. Even louder.'));
    check('the bundled module is untouched',
        !BUILTIN_PROMPTS.lunatic.systemPrompt.includes('Even louder'));
    check('other voices still come from the bundle',
        lib.builtins(s).tour.systemPrompt === BUILTIN_PROMPTS.tour.systemPrompt);
    check('a rider on it gets the new text',
        (lib.setActive(s, 'lunatic'), lib.resolvePrompt(s).systemPrompt.endsWith('10. Even louder.')));
}

section("but a rider's own copy is never rewritten");
{
    reset();
    const s = makeStore();
    const mine = lib.duplicatePrompt(s, 'lunatic');
    lib.updatePrompt(s, mine, { systemPrompt: 'My own words entirely.' });
    lib.setActive(s, mine);

    served.table = styles.listPromptDefinitions().map(p => p.id === 'lunatic'
        ? { ...p, version: 5, systemPrompt: 'SERVICE REWROTE THIS' } : p);
    served.revision = 'feedface';
    await updates.checkForUpdates(s, { force: true });

    check('their text is exactly as they left it',
        lib.resolvePrompt(s).systemPrompt === 'My own words entirely.',
        lib.resolvePrompt(s).systemPrompt);
    check('and it is still what would be sent', lib.resolvePrompt(s).kind === 'user');
    check('but reset-to-source now offers the improved original',
        (lib.revertToSource(s, mine), lib.resolvePrompt(s, mine).systemPrompt === 'SERVICE REWROTE THIS'));
}

section('a new voice appears');
{
    reset();
    const s = makeStore();
    await updates.checkForUpdates(s);
    served.table = [...styles.listPromptDefinitions(), {
        id: 'velodrome', version: 1, label: 'Velodrome',
        description: 'Track racing, indoors and shouty.',
        systemPrompt: 'You are calling a track race. One sentence.',
        userPromptTemplate: '{raceContext}\n\n{events}\n\n{watchingSection}\n\n{riders}\n\n{recentLines}\n\nCall it.',
        changelog: ''
    }];
    served.revision = 'newvoice';
    const r = await updates.checkForUpdates(s, { force: true });
    check('it is reported as new', r.added?.[0]?.id === 'velodrome', JSON.stringify(r.added));
    check('and is selectable', lib.listBuiltins(s).some(p => p.id === 'velodrome'));
    check('appended after the bundled ones',
        lib.listBuiltins(s).at(-1).id === 'velodrome', lib.listBuiltins(s).map(p => p.id).join(','));
    check('and usable', (lib.setActive(s, 'velodrome'),
        lib.resolvePrompt(s).systemPrompt.startsWith('You are calling a track race')));
}

section('a voice the service stops listing is kept');
{
    reset();
    const s = makeStore();
    await updates.checkForUpdates(s);
    served.table = styles.listPromptDefinitions().filter(p => p.id !== 'tactical');
    served.revision = 'halfdeploy';
    lib.setActive(s, 'tactical');
    await updates.checkForUpdates(s, { force: true });
    check('a rider on it is not moved off', lib.activeId(s) === 'tactical');
    check('and still gets real text',
        lib.resolvePrompt(s).systemPrompt === BUILTIN_PROMPTS.tactical.systemPrompt);
}

section('a payload that cannot be trusted is refused wholesale or in part');
{
    const bad = [
        ['no data array', '{"revision":"x"}'],
        ['empty data', '{"revision":"x","data":[]}'],
        ['not JSON at all', '<html>502 Bad Gateway</html>'],
        ['every entry malformed', JSON.stringify({ revision: 'x', data: [{ id: 'tour' }] })]
    ];
    for (const [label, body] of bad) {
        reset();
        const s = makeStore();
        served.body = body;
        const r = await updates.checkForUpdates(s);
        check(label, r.status === 'failed', JSON.stringify(r));
        check(`  ...and the bundle still works`,
            lib.resolvePrompt(s).systemPrompt === BUILTIN_PROMPTS.tour.systemPrompt);
    }

    // One rotten entry must not cost the good ones alongside it.
    reset();
    const s = makeStore();
    served.table = [
        ...styles.listPromptDefinitions().map(p => p.id === 'tour' ? { ...p, version: 3 } : p),
        { id: 'usr-abc123', version: 1, label: 'Impostor', description: 'x',
          systemPrompt: 'x', userPromptTemplate: 'x' },
        { id: 'empty', version: 1, label: 'Empty', description: 'x',
          systemPrompt: '   ', userPromptTemplate: 'x' }
    ];
    served.revision = 'mixed';
    await updates.checkForUpdates(s, { force: true });
    check('a usr- id from the service is dropped', !lib.builtins(s)['usr-abc123']);
    check('an empty system prompt is dropped', !lib.builtins(s).empty);
    check('and the good improvement is kept', lib.builtins(s).tour.version === 3);
}

section('a cache already in the bag survives a failed check');
{
    reset();
    const s = makeStore();
    served.table = styles.listPromptDefinitions().map(p => p.id === 'tour' ? { ...p, version: 9 } : p);
    served.revision = 'good';
    await updates.checkForUpdates(s, { force: true });
    check('cached at version 9', lib.builtins(s).tour.version === 9);

    served.body = 'not json';
    const r = await updates.checkForUpdates(s, { force: true });
    check('the bad response fails', r.status === 'failed');
    check('and the good cache is still there', lib.builtins(s).tour.version === 9);
}

section('the service being down changes nothing');
{
    reset();
    const s = makeStore({ hostedBaseUrl: 'http://127.0.0.1:1' });
    const r = await updates.checkForUpdates(s);
    check('reported, not thrown', r.status === 'failed', JSON.stringify(r));
    check('the mod runs on its bundled voices',
        lib.resolvePrompt(s).systemPrompt === BUILTIN_PROMPTS.tour.systemPrompt);
    check('and nothing was cached', lib.readCache(s) === null);
}

section('when to check, and when not to');
{
    reset();
    const s = makeStore();
    check('a fresh install checks', updates.shouldCheck(s));
    await updates.checkForUpdates(s);
    check('then waits', !updates.shouldCheck(s));
    check('for a day', updates.shouldCheck(s, Date.now() + updates.CHECK_INTERVAL_MS));
    check('a clock that went backwards does not wedge it',
        updates.shouldCheck(s, Date.now() - 60_000));

    const off = makeStore({ promptUpdates: 'off' });
    check('turned off, it never checks', !updates.shouldCheck(off));
    reset();
    const r = await updates.checkForUpdates(off, { force: true });
    check('and force does not override the setting', r.status === 'off');
    check('no request was made', served.requests.length === 0);
}

section('the notice a rider actually reads');
{
    reset();
    const s = makeStore();
    await updates.checkForUpdates(s);
    check('nothing to say when nothing changed', updates.pendingNotice(s) === null);

    served.table = styles.listPromptDefinitions().map(p => p.id === 'tour' ? { ...p, version: 2 } : p);
    served.revision = 'r2';
    await updates.checkForUpdates(s, { force: true });
    const n = updates.pendingNotice(s);
    check('a notice is pending', !!n);
    const text = updates.describeNotice(n);
    check('it names the voice', text.includes('Tour de France'), text);
    check('and reassures about your own', text.includes('unchanged'), text);
    updates.dismissNotice(s);
    check('dismissing clears it', updates.pendingNotice(s) === null);
}

server.close();
console.log(bad ? `\n${bad} FAILURE(S)` : '\nall checks passed');
process.exit(bad ? 1 : 0);
