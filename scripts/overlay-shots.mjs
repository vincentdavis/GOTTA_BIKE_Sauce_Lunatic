#!/usr/bin/env node
/**
 * Screenshot the OVERLAY window, with its real CSS, in Chromium.
 *
 * settings-shots.mjs covers the settings window; nothing covered this one, and
 * it is the window a rider actually watches. That gap shipped a layout bug for
 * as long as the history block has existed: #commentary-container was flex:1,
 * so it grew to fill the window and pushed the previous lines to the bottom
 * edge. One line at the top, a screen of black, then history far below — which
 * reads as history never updating, because it is nowhere near the line that
 * just changed. Nothing in the repo would have shown that: the boot tests
 * execute the code, and the code was fine.
 *
 *   node scripts/overlay-shots.mjs            # -> build/shots-overlay/
 *   node scripts/overlay-shots.mjs out/dir
 *
 * The overlay only fills itself from live `nearby` data and a streaming API
 * call, neither of which exists here, so each state boots the real page and
 * then injects the exact markup displayCommentary()/renderHistory() produce.
 * That makes this a test of the CSS, which is what the bug was. Same caveats as
 * the settings shooter: the base stylesheet is an APPROXIMATION of Sauce's and
 * <ms> icons are placeholder glyphs.
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = resolve(process.argv[2] || join(REPO, 'build', 'shots-overlay'));
const PORT = 9318;
const BASE = `http://127.0.0.1:${PORT}`;

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

const MIME = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript',
               '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };

const server = createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/pages/src/common.mjs') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(readFileSync(join(REPO, 'scripts/lib/browser-common-stub.mjs'))); }
    if (p === '/pages/css/common.css') { res.writeHead(200, { 'Content-Type': 'text/css' }); return res.end(readFileSync(join(REPO, 'scripts/lib/sauce-common-approx.css'))); }
    const rel = p.startsWith('/pages/') ? p.slice('/pages/'.length) : p.replace(/^\//, '');
    const file = join(REPO, 'pages', rel);
    if (existsSync(file) && !file.endsWith('/')) {
        res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
        return res.end(readFileSync(file));
    }
    res.writeHead(404); res.end('not found ' + p);
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));

const GLYPHS = { close: '✕', volume_up: '🔊', volume_off: '🔇', settings: '⚙',
                 refresh: '↻', pause: '⏸', play_arrow: '▶', content_copy: '⧉' };

const LINES = [
    ["Cox launches out of the group with a huge dig, seven point six watts per kilo, and Jang simply can't go with it, brought straight back into the fold behind, while Bayer slips further away now, over two minutes lost.", '6:45:48 PM'],
    ['Puma, Waddington and Dooley all losing eight seconds in ten now, the group up the road fracturing as we head into the final six kilometres.', '6:41:57 PM'],
    ['Porras closes to within two seconds of the leading group as Schreiber slips back eleven, Hanson now adrift by twenty-four.', '6:41:30 PM'],
    ['Bianco has come adrift, thirty-five seconds lost in the last ten kilometres, and Vasquez has stretched her advantage to fifty seconds up the road.', '6:41:03 PM']
];

// 420x340 is the manifest's default_bounds. The taller sizes are what a rider
// who drags the window bigger gets -- and the bigger the window, the worse the
// grow-to-fill bug looked, because the gap it opened was the spare height.
const STATES = [
    { name: '01-default-bounds', w: 420, h: 340, lines: 4 },
    { name: '02-tall-window', w: 690, h: 745, lines: 4,
      note: 'Roughly the size in the bug report. Every spare pixel used to go between the current line and the history.' },
    { name: '03-one-line-only', w: 420, h: 340, lines: 1, note: 'Before any history exists.' },
    { name: '04-history-off', w: 420, h: 340, lines: 4, historyOff: true },
    { name: '05-narrow-tall', w: 380, h: 600, lines: 4 }
];

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const manifest = [];
let pageErrors = 0;
// The previous line should sit just under the current one. Anything larger is
// something growing to fill the window again; anything very negative is history
// pushed off the bottom, which is the same bug in a small window.
const MAX_GAP = 40;
let badGaps = 0;

for (const st of STATES) {
    const ctx = await browser.newContext({ viewport: { width: st.w, height: st.h }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.addInitScript(seed => { window.__SEED = seed; },
        { aiProvider: 'anthropic', claudeApiKey: 'sk-ant-api03-EXAMPLE', backgroundOption: 'black' });
    await page.goto(`${BASE}/pages/announcer.html`);
    await page.waitForTimeout(500);
    await page.evaluate(g => { for (const el of document.querySelectorAll('ms')) el.textContent = g[el.textContent.trim()] || '▪'; }, GLYPHS);

    // The markup displayCommentary() and renderHistory() build, by hand: there
    // is no live data and no API here.
    await page.evaluate(({ lines, historyOff }) => {
        const [cur, ...rest] = lines;
        const container = document.getElementById('current-commentary');
        container.querySelector('.commentary-text').innerHTML = `<p>${cur[0]}</p>`;
        const ts = document.createElement('div');
        ts.className = 'commentary-timestamp';
        ts.textContent = cur[1];
        container.appendChild(ts);

        const hist = document.getElementById('history-container');
        if (historyOff || !rest.length) { hist.hidden = true; return; }
        hist.hidden = false;
        document.getElementById('history-entries').innerHTML = rest.map(([t, at]) => `
            <div class="history-entry">
                <div class="commentary-text"><p>${t}</p></div>
                <div class="commentary-timestamp">${at}</div>
            </div>`).join('');
    }, { lines: LINES.slice(0, st.lines), historyOff: !!st.historyOff });

    await page.waitForTimeout(200);
    await page.screenshot({ path: join(OUT, `${st.name}.png`) });

    // Blank pixels between the line just spoken and the first previous line.
    // Measured from #current-commentary, NOT from its container: the container
    // was the thing that grew, so its own bottom sat against the history all
    // along while ~600px of nothing opened up INSIDE it. Measuring the wrong
    // box reported a healthy 7px gap on the broken CSS.
    const gap = await page.evaluate(() => {
        const cur = document.getElementById('current-commentary').getBoundingClientRect();
        const hist = document.getElementById('history-container');
        if (hist.hidden) return null;
        return Math.round(hist.getBoundingClientRect().top - cur.bottom);
    });
    const gapBad = gap !== null && Math.abs(gap) > MAX_GAP;
    if (gapBad) badGaps++;
    manifest.push({ name: st.name, size: `${st.w}x${st.h}`, gapPx: gap, gapBad, note: st.note || '', errors });
    pageErrors += errors.length;
    console.log(`${st.name.padEnd(22)} ${`${st.w}x${st.h}`.padStart(9)}  gap ${gap === null ? 'n/a' : `${gap}px`}` +
        `${gapBad ? '  <-- BLANK SPACE between the current line and the history' : ''}` +
        `${errors.length ? '  PAGE ERRORS: ' + errors.join(' | ') : ''}`);
    await ctx.close();
}

await browser.close();
server.close();
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`\n${STATES.length} states -> ${OUT}` +
    `${pageErrors ? `\n${pageErrors} uncaught page error(s)` : ''}` +
    `${badGaps ? `\n${badGaps} state(s) with a gap over ${MAX_GAP}px between the current line and the history` : ''}`);
process.exit(pageErrors || badGaps ? 1 : 0);
