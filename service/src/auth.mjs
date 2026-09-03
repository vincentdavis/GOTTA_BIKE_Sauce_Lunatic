/**
 * Identity, without accounts.
 *
 * A device token is an HMAC-signed opaque string minted on first run and kept
 * in the mod's settings. It identifies a device, not a person, and it is
 * trivially farmable -- clear storage, get a new one. That is understood and
 * accepted: the token exists to attribute honest traffic, and the GLOBAL SPEND
 * BREAKER in quota.mjs is what actually bounds abuse. Do not add complexity
 * here in the hope of making the token unforgeable; it cannot be, and the
 * breaker makes it unnecessary.
 *
 * Two secondary signals harden the bucket for free requests:
 *   - the Zwift athlete id, which Sauce already knows and which does NOT reset
 *     when browser storage is cleared. It is not a secret and anyone can claim
 *     any value, so it is used only as a rate-limit bucket, never as proof of
 *     identity.
 *   - the client IP.
 *
 * ACCOUNTS (later): Discord OAuth. The shape is already here -- an identity is
 * `{kind, id}`, and a Discord login simply produces `{kind:'discord', id:<user
 * id>}` with a higher quota and permission to send its own system prompt. The
 * rest of the service asks `identity.kind`, so nothing below the auth layer
 * needs to change when that lands.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { TOKEN_SECRET } from './config.mjs';

// A per-boot secret is fine for anonymous device tokens: the worst case on
// restart is that clients re-mint. Set TOKEN_SECRET to keep them stable across
// deploys, which you want once there is real traffic.
const SECRET = TOKEN_SECRET || randomBytes(32).toString('hex');

if (!TOKEN_SECRET) {
    console.warn('[auth] TOKEN_SECRET is unset — device tokens will not survive a restart. ' +
                 'Set it in Railway before opening the free tier to the public.');
}

const TOKEN_PREFIX = 'lun_';

function sign(payload) {
    return createHmac('sha256', SECRET).update(payload).digest('base64url');
}

/** Mint an anonymous device token. */
export function mintDeviceToken() {
    const id = randomBytes(16).toString('base64url');
    const issued = Math.floor(Date.now() / 1000);
    const payload = `${id}.${issued}`;
    return `${TOKEN_PREFIX}${payload}.${sign(payload)}`;
}

/** Verify a device token and return its stable device id, or null. */
export function verifyDeviceToken(token) {
    if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX)) return null;
    const parts = token.slice(TOKEN_PREFIX.length).split('.');
    if (parts.length !== 3) return null;

    const [id, issued, mac] = parts;
    const expected = sign(`${id}.${issued}`);

    // Constant-time compare. Length must match first, or timingSafeEqual throws.
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

    return id;
}

function clientIp(req) {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.length) {
        // Railway appends the real client IP; take the first entry.
        return fwd.split(',')[0].trim();
    }
    return req.socket?.remoteAddress || 'unknown';
}

/**
 * Resolve the caller.
 *
 * Returns {kind, id, bucket, canUseCustomPrompt}. `bucket` is what quota
 * counting keys on; `id` is the durable identity.
 */
export function identify(req) {
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';

    const deviceId = verifyDeviceToken(token);
    if (!deviceId) {
        return { kind: 'anonymous', id: null, bucket: null, canUseCustomPrompt: false };
    }

    // The athlete id does not reset when storage is cleared, so it is the
    // better bucket when present. Falling back to the device id alone is fine;
    // the breaker is the real backstop either way.
    const athlete = String(req.headers['x-lunatic-athlete'] || '').trim();
    const athleteBucket = /^\d{1,12}$/.test(athlete) ? `z:${athlete}` : null;

    return {
        kind: 'device',
        id: deviceId,
        bucket: athleteBucket || `d:${deviceId}`,
        ip: clientIp(req),
        // Free tier: the service supplies the announcer voice. See styles.mjs
        // for why this is the enforcement point.
        canUseCustomPrompt: false
    };
}
