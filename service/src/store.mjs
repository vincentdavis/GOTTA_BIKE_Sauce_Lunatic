/**
 * The one storage layer. Redis when REDIS_URL is set, an in-process Map
 * otherwise.
 *
 * The in-memory fallback is real and works, but it RESETS ON EVERY DEPLOY AND
 * RESTART, which on Railway happens often. For quota counters that is merely
 * bad — everyone gets a fresh allowance and the daily spend breaker forgets
 * what the day cost. For ACCOUNTS it would be data loss: someone signs in with
 * Discord, gets a key, and the next deploy makes that key meaningless.
 *
 * So accounts refuse to operate at all unless `storageIsDurable()`. That check
 * lives at the route level in index.mjs; this module only reports the truth.
 */

import { REDIS_URL } from './config.mjs';

let redis = null;
let redisReady = false;

export async function initStorage() {
    if (!REDIS_URL) return;
    try {
        const { createClient } = await import('redis');
        redis = createClient({ url: REDIS_URL });
        redis.on('error', err => {
            // Never throw from here: a dropped Redis connection must degrade,
            // not take down everyone currently mid-stream.
            console.error('[store] redis error:', err.message);
            redisReady = false;
        });
        redis.on('ready', () => { redisReady = true; });
        await redis.connect();
        redisReady = true;
        console.log('[store] using redis');
    } catch (err) {
        console.error('[store] redis unavailable, falling back to memory:', err.message);
        redis = null;
        redisReady = false;
    }
}

export function storageIsDurable() {
    return !!(redis && redisReady);
}

// --- in-memory fallback ----------------------------------------------------

const mem = new Map(); // key -> {value, expiresAt|null}

function memGet(key) {
    const e = mem.get(key);
    if (!e) return null;
    if (e.expiresAt && Date.now() > e.expiresAt) {
        mem.delete(key);
        return null;
    }
    return e.value;
}

function memSet(key, value, ttlSec) {
    const existing = mem.get(key);
    mem.set(key, {
        value,
        // Keep the original expiry so a busy key cannot extend its own window
        // and escape a rolling limit.
        expiresAt: existing?.expiresAt ?? (ttlSec ? Date.now() + ttlSec * 1000 : null)
    });
}

setInterval(() => {
    const now = Date.now();
    for (const [k, e] of mem) if (e.expiresAt && now > e.expiresAt) mem.delete(k);
}, 60_000).unref?.();

// --- numbers (quota counters, spend) --------------------------------------

/** Add to a counter and return the new value. Sets the TTL only on creation. */
export async function addNumber(key, amount, ttlSec) {
    if (storageIsDurable()) {
        try {
            const next = await redis.incrByFloat(key, amount);
            if (Math.abs(next - amount) < 1e-9 && ttlSec) await redis.expire(key, ttlSec);
            return next;
        } catch (err) {
            console.error('[store] redis incr failed, using memory:', err.message);
        }
    }
    const next = (Number(memGet(key)) || 0) + amount;
    memSet(key, next, ttlSec);
    return next;
}

export async function readNumber(key) {
    if (storageIsDurable()) {
        try {
            return Number(await redis.get(key)) || 0;
        } catch (err) {
            console.error('[store] redis get failed, using memory:', err.message);
        }
    }
    return Number(memGet(key)) || 0;
}

// --- JSON records (accounts, pairing, oauth state) ------------------------

/** @param ttlSec omit for a permanent record — accounts must never expire. */
export async function setJson(key, value, ttlSec) {
    const raw = JSON.stringify(value);
    if (storageIsDurable()) {
        try {
            if (ttlSec) await redis.set(key, raw, { EX: ttlSec });
            else await redis.set(key, raw);
            return;
        } catch (err) {
            console.error('[store] redis set failed, using memory:', err.message);
        }
    }
    memSet(key, raw, ttlSec);
}

export async function getJson(key) {
    let raw = null;
    if (storageIsDurable()) {
        try {
            raw = await redis.get(key);
        } catch (err) {
            console.error('[store] redis get failed, using memory:', err.message);
            raw = memGet(key);
        }
    } else {
        raw = memGet(key);
    }
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

export async function delKey(key) {
    if (storageIsDurable()) {
        try {
            await redis.del(key);
            return;
        } catch (err) {
            console.error('[store] redis del failed:', err.message);
        }
    }
    mem.delete(key);
}
