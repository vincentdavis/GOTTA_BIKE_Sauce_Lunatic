/**
 * Sign in with Discord, and the pairing flow that gets the resulting key back
 * into the mod.
 *
 * THE PROBLEM: the mod is an overlay inside a desktop app. It cannot receive an
 * OAuth redirect, and asking a rider to copy a long key out of a browser and
 * into a settings field mid-setup is exactly the friction the hosted tier
 * exists to remove.
 *
 * THE SHAPE (the device-authorization pattern):
 *   1. mod  -> POST /v1/pair/start        gets a public `code` and a secret `pollToken`
 *   2. mod  -> opens /auth/discord/start?code=… in the system browser
 *   3. user -> authorises on Discord, which redirects to /auth/discord/callback
 *   4. svc  -> creates or finds the account, binds the key to the pairing code
 *   5. mod  -> POST /v1/pair/poll with the pollToken, receives the key
 *
 * Two values, not one, and on purpose: the `code` travels through a browser
 * URL and a redirect chain, so it is treated as public. The `pollToken` never
 * leaves the mod, so only the client that started the flow can collect the key.
 *
 * The success page still shows the key in full, so a rider whose poll failed —
 * mod restarted, network blipped — can finish by hand instead of starting over.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { getJson, setJson, delKey } from './store.mjs';
import { upsertDiscordAccount, fetchDiscordProfile } from './accounts.mjs';
import {
    DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_REDIRECT_URI, publicUrl
} from './config.mjs';

const PAIR_TTL_SEC = 900;   // 15 minutes to finish a browser sign-in

const codeKey = c => `pair:code:${c}`;
const tokKey = t => `pair:tok:${t}`;
const stateKey = s => `oauth:state:${s}`;

function rand(bytes = 24) {
    return randomBytes(bytes).toString('base64url');
}

/** Constant-time string compare that tolerates length mismatch. */
function sameSecret(a, b) {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

export async function startPairing() {
    const code = rand(12);
    const pollToken = rand(24);

    await setJson(tokKey(pollToken), { code, status: 'pending' }, PAIR_TTL_SEC);
    await setJson(codeKey(code), { pollToken }, PAIR_TTL_SEC);

    return {
        code,
        pollToken,
        verifyUrl: `${publicUrl()}/auth/discord/start?code=${encodeURIComponent(code)}`,
        expiresIn: PAIR_TTL_SEC
    };
}

export async function pollPairing(pollToken) {
    if (!pollToken) return { status: 'invalid' };
    const rec = await getJson(tokKey(pollToken));
    if (!rec) return { status: 'expired' };
    if (rec.status !== 'complete') return { status: 'pending' };

    // One-shot: the key has been handed over, so the pairing record is spent.
    await delKey(tokKey(pollToken));
    await delKey(codeKey(rec.code));

    return { status: 'complete', key: rec.key, account: rec.account };
}

async function bindPairing(code, key, account) {
    const codeRec = await getJson(codeKey(code));
    if (!codeRec?.pollToken) return false;
    const tok = codeRec.pollToken;
    const rec = await getJson(tokKey(tok));
    if (!rec) return false;
    if (!sameSecret(rec.code, code)) return false;

    await setJson(tokKey(tok), { ...rec, status: 'complete', key, account }, PAIR_TTL_SEC);
    return true;
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

export async function discordAuthorizeUrl(pairCode) {
    const state = rand(18);
    await setJson(stateKey(state), { pairCode: pairCode || null }, PAIR_TTL_SEC);

    const params = new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        redirect_uri: DISCORD_REDIRECT_URI,
        response_type: 'code',
        scope: 'identify',      // a stable id and a display name; nothing else
        state,
        prompt: 'none'          // don't re-prompt a user who already approved
    });
    return `https://discord.com/oauth2/authorize?${params}`;
}

/**
 * Handle the redirect back from Discord.
 * @returns {{key, account, paired}} on success; throws with a user-safe message.
 */
export async function handleDiscordCallback({ code, state }) {
    if (!code) throw new Error('Discord did not send an authorisation code.');

    const stateRec = state ? await getJson(stateKey(state)) : null;
    if (!stateRec) throw new Error('This sign-in link has expired. Start again from the mod.');
    await delKey(stateKey(state));   // one use only

    const profile = await fetchDiscordProfile({
        code,
        clientId: DISCORD_CLIENT_ID,
        clientSecret: DISCORD_CLIENT_SECRET,
        redirectUri: DISCORD_REDIRECT_URI
    });

    const { key, account, created } = await upsertDiscordAccount(profile);

    let paired = false;
    if (stateRec.pairCode) paired = await bindPairing(stateRec.pairCode, key, account);

    return { key, account, created, paired };
}

// ---------------------------------------------------------------------------
// The page the rider lands on
// ---------------------------------------------------------------------------

function esc(s) {
    return String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const PAGE_CSS = `
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#10161A; color:#E3E8E9;
         font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; padding:24px; }
  .card { max-width:520px; width:100%; background:#182027; border:1px solid #26323A;
          border-radius:10px; padding:28px 30px; }
  h1 { margin:0 0 6px; font-size:26px; line-height:1.15; }
  .sub { color:#A0AEB4; margin:0 0 22px; }
  .ok { color:#6FB0A2; } .bad { color:#DC7A61; }
  .key { font-family:ui-monospace,Menlo,Consolas,monospace; font-size:13px; word-break:break-all;
         background:#0E1418; border:1px solid #26323A; border-radius:6px; padding:12px 14px;
         margin:0 0 8px; user-select:all; }
  .hint { color:#77878E; font-size:14px; margin:0; }
  button { font:inherit; font-size:14px; background:#E9A63F; color:#10161A; border:0;
           border-radius:6px; padding:8px 14px; cursor:pointer; margin-bottom:14px; }
  button:focus-visible { outline:2px solid #E9A63F; outline-offset:3px; }
`;

export function successPage({ account, key, paired }) {
    const who = esc(account.username);
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Signed in — Lunatic Announcer</title><style>${PAGE_CSS}</style></head><body>
<div class="card">
  <h1>Signed in as ${who}</h1>
  ${paired
    ? `<p class="sub ok">Your announcer is connected. You can close this tab and go back to Sauce.</p>`
    : `<p class="sub">Your key is ready. The mod did not pick it up automatically, so copy it into
       the settings window yourself &mdash; <strong>AI Provider</strong> tab, Lunatic hosted.</p>`}
  <div class="key" id="k">${esc(key)}</div>
  <button type="button" id="c">Copy key</button>
  <p class="hint">Keep this key private &mdash; anyone who has it can spend your monthly allowance.
  Signing in again on any machine returns this same key.</p>
</div>
<script>
document.getElementById('c').addEventListener('click', async () => {
    const b = document.getElementById('c');
    try {
        await navigator.clipboard.writeText(document.getElementById('k').textContent);
        b.textContent = 'Copied';
    } catch (e) {
        b.textContent = 'Select the key above and copy it';
    }
});
</script>
</body></html>`;
}

export function errorPage(message) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign-in failed — Lunatic Announcer</title><style>${PAGE_CSS}</style></head><body>
<div class="card">
  <h1 class="bad">Sign-in failed</h1>
  <p class="sub">${esc(message)}</p>
  <p class="hint">Close this tab and press Sign in with Discord again in the mod. If it keeps
  failing, the anonymous Connect button works without an account.</p>
</div></body></html>`;
}
