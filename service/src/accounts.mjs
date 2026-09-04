/**
 * Accounts and their keys.
 *
 * An account is created by signing in with Discord. It holds a long-lived key
 * the mod sends as a bearer token, exactly where an anonymous device token
 * would go — so nothing downstream of auth.mjs needs to know which it got.
 *
 * WHY SIGNING IN IS WORTH IT, for the rider:
 *   - the key survives a reinstall or a cleared settings bag; sign in again and
 *     you get the SAME key back, not a new identity
 *   - a larger monthly allowance than an anonymous device token
 *   - it is the thing a paid tier will later attach to
 *
 * And for the operator: a real, de-duplicated user count, and an identity that
 * cannot be reset by clearing storage — which an anonymous device token can.
 *
 * Re-signing in must return the EXISTING key. Minting a new one on every login
 * would silently reset the user's quota and hand out a fresh allowance to
 * anyone who logs out and back in, which is the whole thing accounts are
 * supposed to prevent.
 */

import { randomBytes } from 'node:crypto';
import { getJson, setJson } from './store.mjs';
import { DISCORD_API_BASE } from './config.mjs';

// Distinct prefix from device tokens (`lun_`) so auth.mjs can tell them apart
// before doing any lookup.
const KEY_PREFIX = 'luna_';

const keyRecord = key => `acct:key:${key}`;
const discordIndex = id => `acct:discord:${id}`;

export function looksLikeAccountKey(token) {
    return typeof token === 'string' && token.startsWith(KEY_PREFIX);
}

/** Resolve a key to its account, or null. */
export async function accountForKey(key) {
    if (!looksLikeAccountKey(key)) return null;
    return getJson(keyRecord(key));
}

/**
 * Find or create the account for a Discord user.
 *
 * `profile` is {id, username, globalName} straight off Discord's /users/@me.
 * Everything but the id is display-only and is treated as untrusted text.
 */
export async function upsertDiscordAccount(profile) {
    const existingKey = await getJson(discordIndex(profile.id));

    if (existingKey) {
        const account = await getJson(keyRecord(existingKey));
        if (account) {
            // Refresh the display name — people rename themselves — but never
            // the key, the tier or the creation date.
            const updated = {
                ...account,
                username: profile.globalName || profile.username || account.username,
                lastSeen: new Date().toISOString()
            };
            await setJson(keyRecord(existingKey), updated);
            return { key: existingKey, account: updated, created: false };
        }
        // Index pointed at a record that is gone. Fall through and re-mint
        // rather than handing back a key that resolves to nothing.
    }

    const key = KEY_PREFIX + randomBytes(24).toString('base64url');
    const account = {
        discordId: profile.id,
        username: profile.globalName || profile.username || 'Unknown',
        tier: 'free',
        createdAt: new Date().toISOString(),
        lastSeen: new Date().toISOString()
    };

    // Record first, then the index: a crash between the two leaves an
    // unreachable record rather than an index pointing at nothing.
    await setJson(keyRecord(key), account);
    await setJson(discordIndex(profile.id), key);

    return { key, account, created: true };
}

/**
 * Exchange an OAuth code for a Discord profile.
 *
 * Only the `identify` scope is requested: this needs a stable user id and a
 * name to show. It deliberately does not ask for an email address — there is
 * nothing here that would use one, and not holding it is simpler than holding
 * it responsibly.
 */
export async function fetchDiscordProfile({ code, clientId, clientSecret, redirectUri }) {
    const tokenRes = await fetch(`${DISCORD_API_BASE}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri
        })
    });

    if (!tokenRes.ok) {
        const detail = await tokenRes.text().catch(() => '');
        // Log the detail, never show it: it can echo the client secret back.
        console.error('[discord] token exchange failed:', tokenRes.status, detail.slice(0, 200));
        throw new Error('Discord rejected the sign-in. Try again.');
    }

    const { access_token: accessToken } = await tokenRes.json();
    if (!accessToken) throw new Error('Discord returned no access token.');

    const userRes = await fetch(`${DISCORD_API_BASE}/users/@me`, {
        headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!userRes.ok) throw new Error('Could not read your Discord profile.');

    const u = await userRes.json();
    if (!u?.id) throw new Error('Discord returned no user id.');

    return { id: String(u.id), username: u.username || '', globalName: u.global_name || '' };
}
