#!/usr/bin/env node
/**
 * Screenshot every state of the settings window, with its real JavaScript
 * running in Chromium at the 700x600 Sauce opens it at.
 *
 * The boot tests prove the code runs; nothing else in this repo shows what it
 * LOOKS like without installing the zip into Sauce. This serves pages/ with a
 * stub for Sauce's common.mjs and a mock of the hosted service, drives each
 * state (tab, provider, connection, prompt editor, notice, diff), and writes
 * NN-name.png (the 700x600 viewport) and NN-name-full.png (the whole page).
 *
 *   node scripts/settings-shots.mjs            # -> build/shots/
 *   node scripts/settings-shots.mjs out/dir    # anywhere else
 *
 * Needs Playwright's Chromium; not run in CI on purpose (the repo has no npm
 * step and this is a look-at-it tool, not a gate). Caveat for the viewer: the
 * base stylesheet is an APPROXIMATION of Sauce's, and <ms> icons are drawn as
 * placeholder glyphs — judge the mod's own structure and CSS, not the host's.
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = resolve(process.argv[2] || join(REPO, 'build', 'shots'));
const PORT = 9317;
const BASE = `http://127.0.0.1:${PORT}`;

// Playwright is not a dependency of this repo; find a global install.
let chromium;
try {
    ({ chromium } = await import('playwright'));
} catch {
    try {
        ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs'));
    } catch {
        console.error('playwright not found: npm i -g playwright && npx playwright install chromium');
        process.exit(2);
    }
}

// ---------------------------------------------------------------------------
// The server: pages/ + stubs + a mock of the hosted service
// ---------------------------------------------------------------------------
const { listPromptDefinitions, promptsRevision } = await import(`${REPO}/service/src/styles.mjs`);
const MIME = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript',
               '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*',
               'Access-Control-Allow-Methods': '*' };
const json = (res, o) => { res.writeHead(200, { 'Content-Type': 'application/json', ...CORS }); res.end(JSON.stringify(o)); };

const server = createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    if (p === '/pages/src/common.mjs') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(readFileSync(join(REPO, 'scripts/lib/browser-common-stub.mjs'))); }
    if (p === '/pages/css/common.css') { res.writeHead(200, { 'Content-Type': 'text/css' }); return res.end(readFileSync(join(REPO, 'scripts/lib/sauce-common-approx.css'))); }
    // Just enough hosted service for the connected states to render.
    if (p === '/v1/models') return json(res, { data: [
        { id: 'free-fast', label: 'Fast', description: 'Lowest latency. The commentary starts talking soonest.' },
        { id: 'free-balanced', label: 'Balanced', description: 'A better turn of phrase, at slightly higher latency.' },
        { id: 'free-colour', label: 'Colour', description: 'The most characterful of the three. Slowest to first word.' }] });
    if (p === '/v1/quota') return json(res, { remaining: 137, limit: 150 });
    if (p === '/v1/device') return json(res, { token: 'lun_mock_device_token' });
    if (p === '/v1/prompts') return json(res, { object: 'list', revision: promptsRevision(), default: 'tour', data: listPromptDefinitions() });
    const rel = p.startsWith('/pages/') ? p.slice('/pages/'.length) : p.replace(/^\//, '');
    const file = join(REPO, 'pages', rel);
    if (existsSync(file) && !file.endsWith('/')) {
        res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
        return res.end(readFileSync(file));
    }
    res.writeHead(404); res.end('not found ' + p);
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));

// ---------------------------------------------------------------------------
// The states
// ---------------------------------------------------------------------------
const HOSTED = { aiProvider: 'hosted', hostedBaseUrl: BASE };
const KEYED = { aiProvider: 'anthropic', claudeApiKey: 'sk-ant-api03-EXAMPLEKEYEXAMPLEKEY' };
const GLYPHS = { close: '✕', visibility: '👁', visibility_off: '🙈', volume_up: '🔊', volume_off: '🔇',
                 settings: '⚙', refresh: '↻', pause: '⏸', play_arrow: '▶', content_copy: '⧉' };
const TEMPLATE = '{raceContext}\n{events}\n{watchingSection}\n{riders}\n{recentLines}';

export const STATES = [
    { name: '01-settings-tab', seed: {}, tab: 'settings-tab' },
    { name: '02-api-first-run', seed: {}, tab: 'api-tab', note: 'Fresh install: nothing configured. What a new rider sees first.' },
    { name: '03-api-anthropic-configured', seed: KEYED, tab: 'api-tab' },
    { name: '04-api-compatible-gemini', seed: { aiProvider: 'compatible', compatPreset: 'gemini',
        compatBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', compatApiKey: 'AIzaEXAMPLE', compatModel: 'gemini-2.5-flash' }, tab: 'api-tab' },
    { name: '05-api-hosted-disconnected', seed: { ...HOSTED }, tab: 'api-tab' },
    { name: '06-api-hosted-anon-connected', seed: { ...HOSTED, '/gotta-bike-lunatic-device-token': 'lun_mock_device_token', '/gotta-bike-lunatic-quota': 137 }, tab: 'api-tab' },
    // 'luna_' is the account-key prefix tokenKind() recognises; 'lun_' is an
    // anonymous device token. The first cut of this harness got that wrong and
    // the "Discord" state silently rendered as Anonymous — a review caveat.
    { name: '07-api-hosted-discord', seed: { ...HOSTED, '/gotta-bike-lunatic-device-token': 'luna_acct_mock', '/gotta-bike-lunatic-quota': 380,
        '/gotta-bike-lunatic-account': { name: 'vincent' } }, tab: 'api-tab' },
    { name: '08-prompts-builtin', seed: { ...HOSTED }, tab: 'prompts-tab' },
    { name: '09-prompts-own-editing', seed: KEYED, tab: 'prompts-tab',
      act: async p => { await p.click('#prompt-duplicate-btn'); await p.fill('#prompt-name', 'My race call'); await p.type('#custom-system-prompt', ' '); } },
    { name: '10-prompts-own-on-hosted', seed: { ...HOSTED }, tab: 'prompts-tab', act: async p => { await p.click('#prompt-duplicate-btn'); },
      note: 'A rider on the free tier editing their own prompt — which the free tier discards.' },
    { name: '11-prompts-update-notice', seed: { ...KEYED, promptUpdates: 'off',
        promptUpdateNotice: { updated: [{ id: 'lunatic', label: 'Lunatic', from: 1, to: 2 }], added: [] },
        builtinPrompts: { revision: 'r2', fetchedAt: 1,
          data: [{ id: 'lunatic', version: 2, label: 'Lunatic', description: 'Louder.',
            systemPrompt: 'You are a live bike-race commentator who has lost it.\nRULES\n1. Call the EVENTS.\n2. One sentence. Two if earned.', userPromptTemplate: TEMPLATE }],
          previous: { lunatic: { version: 1, systemPrompt: 'You are a live bike-race commentator who has lost it.\nRULES\n1. Call the EVENTS.\n2. One sentence, occasionally two.', userPromptTemplate: TEMPLATE } } } },
      tab: 'prompts-tab', act: async p => { await p.click('#prompt-notice-diff'); } },
    { name: '12-prompts-delete-armed', seed: KEYED, tab: 'prompts-tab', act: async p => { await p.click('#prompt-duplicate-btn'); await p.click('#prompt-delete-btn'); } },
    { name: '13-data-tab', seed: {}, tab: 'data-tab' },
    { name: '14-help-tab', seed: {}, tab: 'help-tab' },
];

// ---------------------------------------------------------------------------
mkdirSync(OUT, { recursive: true });
// CHROMIUM_PATH lets a machine whose browser build does not match the local
// Playwright version point at the one it has, rather than downloading another.
const browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const manifest = [];
let pageErrors = 0;
for (const st of STATES) {
    const ctx = await browser.newContext({ viewport: { width: 700, height: 600 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    const errors = [];
    // Uncaught exceptions are what the boot tests exist to catch; here they are
    // reported per state. Network noise from the daily prompt check reaching
    // out to the real service is not an error of the page.
    page.on('pageerror', e => errors.push(String(e)));
    await page.addInitScript(seed => { window.__SEED = seed; }, st.seed);
    await page.goto(`${BASE}/pages/announcer-settings.html`);
    await page.waitForTimeout(3600);   // populateVoicePicker waits up to 3s for voices; headless has none
    await page.evaluate(g => { for (const el of document.querySelectorAll('ms')) el.textContent = g[el.textContent.trim()] || '▪'; }, GLYPHS);
    if (st.tab) await page.click(`.tab-btn[data-tab="${st.tab}"]`);
    if (st.act) await st.act(page);
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(OUT, `${st.name}.png`) });
    await page.screenshot({ path: join(OUT, `${st.name}-full.png`), fullPage: true });
    const fullHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    manifest.push({ name: st.name, tab: st.tab, note: st.note || '', fullHeight, errors });
    pageErrors += errors.length;
    console.log(`${st.name.padEnd(32)} ${String(fullHeight).padStart(5)}px${errors.length ? '  PAGE ERRORS: ' + errors.join(' | ') : ''}`);
    await ctx.close();
}
await browser.close();
server.close();
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`\n${STATES.length} states -> ${OUT}${pageErrors ? `\n${pageErrors} uncaught page error(s) — see manifest.json` : ''}`);
process.exit(pageErrors ? 1 : 0);
