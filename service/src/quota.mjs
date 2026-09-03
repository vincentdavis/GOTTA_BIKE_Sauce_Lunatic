/**
 * Quota counters and the global spend breaker.
 *
 * Two backends. Redis when REDIS_URL is set, an in-process Map otherwise.
 *
 * The in-memory backend is real and works, but it RESETS ON EVERY DEPLOY AND
 * RESTART, which on Railway happens often. That hands every user a fresh
 * allowance and, worse, resets the daily spend breaker. It is fine for local
 * development and for a private beta; it is not fine for a public free tier.
 * `storageIsDurable()` reports which one is live so /healthz can say so out
 * loud rather than letting an operator discover it from a bill.
 */

import {
    REDIS_URL, COST_PER_1M, DAILY_BUDGET_USD,
    FREE_CALLS_PER_MONTH, BURST_CALLS, BURST_WINDOW_SEC
} from './config.mjs';

let redis = null;
let redisReady = false;

export async function initStorage() {
    if (!REDIS_URL) return;
    try {
        const { createClient } = await import('redis');
        redis = createClient({ url: REDIS_URL });
        redis.on('error', err => {
            // Never throw from the error handler: a dropped Redis connection
            // must degrade to memory counting, not take the service down
            // mid-race for everyone currently streaming.
            console.error('[quota] redis error:', err.message);
            redisReady = false;
        });
        redis.on('ready', () => { redisReady = true; });
        await redis.connect();
        redisReady = true;
        console.log('[quota] using redis');
    } catch (err) {
        console.error('[quota] redis unavailable, falling back to memory:', err.message);
        redis = null;
        redisReady = false;
    }
}

export function storageIsDurable() {
    return !!(redis && redisReady);
}

// --- in-memory fallback ----------------------------------------------------

const mem = new Map(); // key -> {value:number, expiresAt:number|null}

function memGet(key) {
    const e = mem.get(key);
    if (!e) return 0;
    if (e.expiresAt && Date.now() > e.expiresAt) {
        mem.delete(key);
        return 0;
    }
    return e.value;
}

function memAdd(key, amount, ttlSec) {
    const cur = memGet(key);
    const next = cur + amount;
    const existing = mem.get(key);
    mem.set(key, {
        value: next,
        // Keep the original expiry so a busy key cannot extend its own window
        // indefinitely and escape the rolling limit.
        expiresAt: existing?.expiresAt ?? (ttlSec ? Date.now() + ttlSec * 1000 : null)
    });
    return next;
}

// Bound the map so a long-lived process cannot grow it without limit.
setInterval(() => {
    const now = Date.now();
    for (const [k, e] of mem) {
        if (e.expiresAt && now > e.expiresAt) mem.delete(k);
    }
}, 60_000).unref?.();

// --- unified operations ----------------------------------------------------

async function add(key, amount, ttlSec) {
    if (storageIsDurable()) {
        try {
            const next = await redis.incrByFloat(key, amount);
            // Only set the TTL when we just created the key, so the window is
            // fixed rather than sliding forward on every hit.
            if (Math.abs(next - amount) < 1e-9 && ttlSec) {
                await redis.expire(key, ttlSec);
            }
            return next;
        } catch (err) {
            console.error('[quota] redis write failed, using memory:', err.message);
        }
    }
    return memAdd(key, amount, ttlSec);
}

async function read(key) {
    if (storageIsDurable()) {
        try {
            return Number(await redis.get(key)) || 0;
        } catch (err) {
            console.error('[quota] redis read failed, using memory:', err.message);
        }
    }
    return memGet(key);
}

// --- key helpers -----------------------------------------------------------

function monthKey(now = new Date()) {
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function dayKey(now = new Date()) {
    return `${monthKey(now)}-${String(now.getUTCDate()).padStart(2, '0')}`;
}

// Seconds until the end of the current UTC month, so a monthly counter expires
// on its own instead of needing a sweep.
function secondsLeftInMonth(now = new Date()) {
    const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
    return Math.max(60, Math.ceil((next - now.getTime()) / 1000));
}

function secondsLeftInDay(now = new Date()) {
    const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    return Math.max(60, Math.ceil((next - now.getTime()) / 1000));
}

// --- public API ------------------------------------------------------------

export async function spentToday() {
    return read(`spend:${dayKey()}`);
}

export async function recordSpend(inputTokens, outputTokens) {
    const usd = (inputTokens / 1e6) * COST_PER_1M.input +
                (outputTokens / 1e6) * COST_PER_1M.output;
    if (!(usd > 0)) return 0;
    return add(`spend:${dayKey()}`, usd, secondsLeftInDay());
}

export async function quotaFor(identity) {
    const used = await read(`calls:${identity}:${monthKey()}`);
    return {
        used,
        limit: FREE_CALLS_PER_MONTH,
        remaining: Math.max(0, FREE_CALLS_PER_MONTH - used),
        resetsAt: new Date(Date.UTC(
            new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1
        )).toISOString()
    };
}

/**
 * Decide whether one request may proceed, and count it if so.
 *
 * Checked in cost order: the global breaker first (it protects the bill and is
 * one read), then the burst window, then the monthly allowance. Counting
 * happens up front rather than on success -- an abandoned or failed stream
 * still cost upstream tokens, and a retry loop that only counted successes
 * would be free.
 */
export async function admit(identity) {
    const spend = await spentToday();
    if (spend >= DAILY_BUDGET_USD) {
        return {
            ok: false,
            code: 'daily_budget_exhausted',
            status: 503,
            message: 'The free announcer has hit its spending limit for today. ' +
                     'It resets at midnight UTC. To keep racing now, add your own ' +
                     'API key in the mod settings.'
        };
    }

    const burst = await add(`burst:${identity}`, 1, BURST_WINDOW_SEC);
    if (burst > BURST_CALLS) {
        return {
            ok: false,
            code: 'rate_limited',
            status: 429,
            retryAfter: BURST_WINDOW_SEC,
            message: 'Too many requests in a short window. Slow the commentary ' +
                     'cadence in settings, or wait a minute.'
        };
    }

    const used = await add(`calls:${identity}:${monthKey()}`, 1, secondsLeftInMonth());
    if (used > FREE_CALLS_PER_MONTH) {
        return {
            ok: false,
            code: 'quota_exhausted',
            status: 402,
            message: `Free tier limit reached (${FREE_CALLS_PER_MONTH} calls this month). ` +
                     'Add your own API key in the mod settings to keep going.'
        };
    }

    return { ok: true, used, remaining: Math.max(0, FREE_CALLS_PER_MONTH - used) };
}
