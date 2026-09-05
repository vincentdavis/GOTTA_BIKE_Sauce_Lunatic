/**
 * The public help page.
 *
 * Everything factual on it is rendered from this service's OWN configuration --
 * the voices from styles.mjs, the models from availableAliases(), the monthly
 * allowances from config.mjs. A help page that states numbers by hand goes
 * stale the first time an operator changes one, and nobody notices because a
 * wrong sentence looks exactly like a right one.
 *
 * Plain HTML, no framework, no build step -- the same rule the mod follows.
 */

import {
    FREE_CALLS_PER_MONTH, ACCOUNT_CALLS_PER_MONTH, MAX_OUTPUT_TOKENS,
    availableAliases, hasAccounts, publicUrl
} from './config.mjs';
import { listStyles } from './styles.mjs';
import { LOGO_SVG } from './logo.mjs';

const REPO = 'https://github.com/vincentdavis/GOTTA_BIKE_Sauce_Lunatic';

function esc(s) {
    return String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const CSS = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin:0; background:#10161A; color:#E3E8E9;
       font:16px/1.65 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
.wrap { max-width:780px; margin:0 auto; padding:40px 24px 72px; }

header { display:flex; align-items:center; gap:18px; margin-bottom:8px; }
header svg { width:64px; height:64px; flex:none; }
h1 { margin:0; font-size:30px; line-height:1.1; letter-spacing:-0.01em; }
.tagline { color:#A0AEB4; margin:2px 0 0; }

h2 { margin:44px 0 4px; font-size:19px; letter-spacing:-0.01em; }
h2:first-of-type { margin-top:36px; }
h3 { margin:22px 0 2px; font-size:15px; color:#E9A63F; }
p { margin:10px 0; }
.lead { color:#A0AEB4; margin-top:0; }

ol, ul { margin:10px 0; padding-left:22px; }
li { margin:6px 0; }

a { color:#8ab4d8; }
a:hover { color:#b9d6ef; }

code, .mono { font-family:ui-monospace,Menlo,Consolas,monospace; font-size:0.88em; }
code { background:#0E1418; border:1px solid #26323A; border-radius:4px; padding:1px 5px; }

.url { display:block; background:#0E1418; border:1px solid #26323A; border-radius:6px;
       padding:11px 13px; margin:10px 0; word-break:break-all; user-select:all;
       font-family:ui-monospace,Menlo,Consolas,monospace; font-size:14px; color:#9FD3C7; }

.card { background:#182027; border:1px solid #26323A; border-radius:10px;
        padding:18px 20px; margin:14px 0; }
.card h3 { margin-top:0; }
.card .meta { color:#93A2A9; font-size:14px; margin:6px 0 0; }

.voice { display:grid; grid-template-columns:150px 1fr; gap:4px 16px; margin:10px 0; }
.voice dt { color:#E9A63F; font-size:15px; }
.voice dd { margin:0; color:#A0AEB4; }

.note { border-left:3px solid #4f9ad6; background:rgba(79,154,214,.1);
        border-radius:4px; padding:12px 14px; margin:16px 0; font-size:15px; }
.warn { border-left-color:#E9A63F; background:rgba(233,166,63,.1); }

/* #93A2A9, not the dimmer grey used elsewhere: 14px secondary text needs
   4.5:1 against #10161A and the darker value does not reach it. */
footer { margin-top:56px; padding-top:20px; border-top:1px solid #26323A;
         color:#93A2A9; font-size:14px; }

@media (max-width:560px) {
  .wrap { padding:28px 18px 56px; }
  header { gap:14px; }
  header svg { width:48px; height:48px; }
  h1 { font-size:24px; }
  .voice { grid-template-columns:1fr; }
  .voice dd { margin-bottom:8px; }
}
`;

function voiceList() {
    return listStyles().map(v =>
        `<dt>${esc(v.label)}</dt><dd>${esc(v.description)}</dd>`).join('\n    ');
}

function modelList() {
    const models = availableAliases();
    if (!models.length) {
        return '<p class="meta">No models are configured on this service right now — ' +
               'use your own API key below.</p>';
    }
    return '<ul>' + models.map(m =>
        `<li><strong>${esc(m.label)}</strong> — ${esc(m.description)}</li>`).join('') + '</ul>';
}

export function helpPage() {
    const url = publicUrl() || 'https://your-service.up.railway.app';
    const accounts = hasAccounts();

    return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>GOTTA.BIKE Sauce Lunatic — an AI race announcer for Sauce4Zwift</title>
<meta name="description" content="Live AI commentary on your Zwift racing, as a Sauce4Zwift mod. Free hosted models, or bring your own API key.">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(LOGO_SVG)}">
<style>${CSS}</style>
</head><body>
<div class="wrap">

<header>
  ${LOGO_SVG}
  <div>
    <h1>Sauce Lunatic</h1>
    <p class="tagline">An AI race announcer for Sauce4Zwift.</p>
  </div>
</header>

<p class="lead">It watches the riders around you and calls the race out loud, one line at a
time, reacting to what actually happens on the road rather than to a timer.</p>

<h2>Install it</h2>
<ol>
  <li>Download the latest <code>.zip</code> from
      <a href="${REPO}/releases/latest">the releases page</a>.</li>
  <li>Unzip it into your Sauce mods folder — <code>~/Documents/SauceMods</code> on macOS,
      <code>Documents\\SauceMods</code> on Windows. You should end up with a folder called
      <code>GOTTA_BIKE_Sauce_Lunatic</code> inside it, not a folder inside a folder.</li>
  <li>Restart Sauce4Zwift, then enable the mod under <strong>Settings &rsaquo; Mods</strong>.</li>
  <li>Open the <strong>Lunatic Announcer</strong> window from Sauce's window list.</li>
</ol>

<h2>Choose how it talks to an AI</h2>
<p>Three options, on the <strong>AI Provider</strong> tab of the settings window. You can
switch between them whenever you like.</p>

<div class="card">
  <h3>Lunatic hosted — free, no API key</h3>
  <p>Paste this service URL into the settings window and press <strong>Connect</strong>:</p>
  <div class="url">${esc(url)}</div>
  <p class="meta">${FREE_CALLS_PER_MONTH} free calls a month connecting anonymously${
      accounts ? `, or ${ACCOUNT_CALLS_PER_MONTH} if you sign in with Discord` : ''
  }. Nothing is billed to you.${
      accounts ? ' Signing in on another machine returns the same key.' : ''
  }</p>
  <p>Models on offer:</p>
  ${modelList()}
</div>

<div class="card">
  <h3>Your own Anthropic key</h3>
  <p>Create a key at <a href="https://console.anthropic.com">console.anthropic.com</a>, paste it
  in, and pick a model. Usage is billed to your account — the overlay shows a running total,
  and a typical line costs a fraction of a cent.</p>
</div>

<div class="card">
  <h3>Anything OpenAI-compatible</h3>
  <p>OpenAI, Google Gemini, OpenRouter, Groq, or a local Ollama. Choose the service, paste a
  key, and enter a model id.</p>
  <p class="meta">Model ids are free text on purpose: they change often, so paste whatever your
  provider currently offers rather than waiting for the mod to catch up.</p>
</div>

<h2>The voices</h2>
<p>Pick one on the <strong>Prompts</strong> tab. The same voice works on every provider.</p>
<dl class="voice">
    ${voiceList()}
</dl>

<h2>Writing your own</h2>
<p>Built-in voices are read-only, but you can keep up to twenty of your own.
<strong>Duplicate &amp; edit</strong> copies the voice you are on so you start from something
that already works; <strong>New from blank</strong> starts empty. Yours appear in the same
dropdown under <em>Your prompts</em>.</p>
<p>The <strong>system message</strong> sets who the announcer is and the rules they follow.
The <strong>user message template</strong> is the race data, with placeholders
(<code>{riders}</code>, <code>{events}</code>, <code>{raceContext}</code> and so on) filled in
each time.</p>
<div class="note warn">On the free hosted service your own prompt is <strong>not</strong> used —
this service supplies the announcer's instructions there. Use your own API key to hear what you
wrote.</div>
<p>When a built-in voice is improved, the mod picks up the new wording and tells you what
changed. Anything you wrote yourself is never touched.</p>

<h2>If nothing happens</h2>
<ul>
  <li><strong>No commentary at all.</strong> Check the dot at the top left of the overlay —
      grey means no provider is configured, red means the last call failed, and hovering it
      says why.</li>
  <li><strong>It is paused.</strong> The second dot is amber when paused, blue in manual mode.
      Use the pause button in the window's title bar.</li>
  <li><strong>Nothing until you are riding.</strong> Commentary fires on what happens around
      you, so it needs other riders nearby — it stays quiet on an empty road.</li>
  <li><strong>A long blank pause before each line.</strong> You have probably picked a
      reasoning model. Replies here are capped at ${MAX_OUTPUT_TOKENS} tokens, so a model that
      thinks first spends the whole budget thinking. Pick a faster one.</li>
  <li><strong>"Check your key or model".</strong> Usually a mistyped key, or a model id your
      provider has retired.</li>
  <li><strong>Out of free calls.</strong> The allowance resets monthly${
      accounts ? '; signing in with Discord gives you a larger one' : ''
  }, and your own API key has no limit but your own.</li>
</ul>

<h2>What gets sent where</h2>
<ul>
  <li>Your API key is stored on your own machine and goes only to the provider you chose.
      This service never sees it.</li>
  <li>On the hosted option, the rider data around you — names, power, heart rate, gaps —
      is sent here and passed to the model. Nothing is kept after the reply.</li>
  <li>The mod checks this service once a day for improved voices. That request carries no
      key, no account and no rider data, and you can turn it off on the Prompts tab.</li>
</ul>

<footer>
  <a href="${REPO}">Source on GitHub</a> ·
  <a href="${REPO}/releases/latest">Latest release</a> ·
  <a href="/healthz">Service status</a>
</footer>

</div></body></html>`;
}
