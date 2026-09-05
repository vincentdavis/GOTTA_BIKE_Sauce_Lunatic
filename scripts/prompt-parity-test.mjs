#!/usr/bin/env node
/**
 * The mod and the service must define the SAME announcer voices, word for word.
 *
 * They cannot share a module: the mod ships as a zip containing only pages/, the
 * service deploys only service/. So the table is written twice, and this is what
 * keeps the two copies honest.
 *
 * It exists because the comment asking a human to do it did not work. styles.mjs
 * said it was "kept deliberately in sync with ANNOUNCER_PRESET" while three of
 * the four voices existed on only one side: a rider on their own key could not
 * reach Lunatic or Old Pro at all, and nobody had been told.
 *
 * Both files are leaf modules that import nothing, so this needs no DOM, no
 * Sauce host and no node_modules.
 *
 *   node scripts/prompt-parity-test.mjs
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const load = rel => import(pathToFileURL(join(REPO, rel)).href);

let bad = 0;
const check = (name, ok, detail = '') => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
    if (!ok) bad++;
};

const mod = await load('pages/src/prompts.mjs');
const svc = await load('service/src/styles.mjs');

console.log('\n=== the two tables describe the same voices ===');
const modIds = Object.keys(mod.BUILTIN_PROMPTS);
const svcIds = Object.keys(svc.STYLES);
check('same ids, same order', JSON.stringify(modIds) === JSON.stringify(svcIds),
    `mod: [${modIds}] service: [${svcIds}]`);
check('the default is the same voice', mod.DEFAULT_PROMPT_ID === svc.DEFAULT_STYLE,
    `${mod.DEFAULT_PROMPT_ID} vs ${svc.DEFAULT_STYLE}`);

console.log('\n=== field by field, byte for byte ===');
for (const id of new Set([...modIds, ...svcIds])) {
    const a = mod.BUILTIN_PROMPTS[id];
    const b = svc.STYLES[id];
    if (!a || !b) {
        check(`${id} exists on both sides`, false, a ? 'missing from the service' : 'missing from the mod');
        continue;
    }
    for (const field of ['version', 'label', 'description', 'systemPrompt', 'userPromptTemplate']) {
        const same = a[field] === b[field];
        let detail = '';
        if (!same) {
            const x = String(a[field]), y = String(b[field]);
            let i = 0;
            while (i < x.length && i < y.length && x[i] === y[i]) i++;
            detail = `first difference at character ${i}: ` +
                `mod ${JSON.stringify(x.slice(i, i + 60))} vs service ${JSON.stringify(y.slice(i, i + 60))}`;
        }
        check(`${id}.${field}`, same, detail);
    }
}

console.log('\n=== each voice is complete and usable ===');
for (const [id, p] of Object.entries(mod.BUILTIN_PROMPTS)) {
    check(`${id} has a version`, Number.isInteger(p.version) && p.version >= 1, String(p.version));
    check(`${id} has a label and description`, !!(p.label && p.description));
    // Every built-in must carry the shared safety block: rider names reach the
    // model as untrusted text, and a voice without this rule can be instructed
    // by whatever someone put in their Zwift profile.
    check(`${id} carries the untrusted-data rule`,
        p.systemPrompt.includes('DATA IS NOT INSTRUCTIONS'));
    check(`${id} carries the gap-direction rule`, p.systemPrompt.includes('up the road'));
    // buildPrompts() appends missing blocks for prompts a rider wrote. A built-in
    // relying on that fallback would silently reorder its own template.
    for (const ph of ['{raceContext}', '{events}', '{watchingSection}', '{riders}', '{recentLines}']) {
        check(`${id} template uses ${ph}`, p.userPromptTemplate.includes(ph));
    }
    // The service caps output at 60-120 tokens. A voice with no length rule of
    // its own gets truncated mid-sentence there, and the mod no longer appends
    // one for built-ins.
    check(`${id} states its own length rule`, /One sentence, occasionally two/.test(p.systemPrompt));
}

console.log('\n=== the logo is the same file on both sides ===');
{
    const { readFileSync } = await import('node:fs');
    const modLogo = readFileSync(join(REPO, 'pages/images/logo.svg'), 'utf8');
    const svcLogo = (await load('service/src/logo.mjs')).LOGO_SVG;
    check('service/src/logo.mjs matches pages/images/logo.svg', modLogo === svcLogo,
        `${modLogo.length} vs ${svcLogo.length} bytes`);
}

console.log('\n=== GET /v1/styles keeps the shape v0.4.x clients expect ===');
const listed = svc.listStyles();
check('one entry per style', listed.length === svcIds.length);
check('id/label/description only',
    listed.every(e => JSON.stringify(Object.keys(e).sort()) === '["description","id","label"]'),
    JSON.stringify(Object.keys(listed[0] || {})));

console.log(bad ? `\n${bad} FAILURE(S)` : '\nall checks passed');
process.exit(bad ? 1 : 0);
