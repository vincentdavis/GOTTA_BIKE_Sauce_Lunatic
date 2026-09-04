/**
 * Quota counters and the global spend breaker.
 *
 * Storage lives in store.mjs; this module is only the policy on top of it.
 */

import {
    COST_PER_1M, DAILY_BUDGET_USD, callsAllowedFor,
    BURST_CALLS, BURST_WINDOW_SEC
} from './config.mjs';
import { addNumber, readNumber } from './store.mjs';

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
    return readNumber(`spend:${dayKey()}`);
}

export async function recordSpend(inputTokens, outputTokens) {
    const usd = (inputTokens / 1e6) * COST_PER_1M.input +
                (outputTokens / 1e6) * COST_PER_1M.output;
    if (!(usd > 0)) return 0;
    return addNumber(`spend:${dayKey()}`, usd, secondsLeftInDay());
}

export async function quotaFor(identity, tier = 'anon') {
    const limit = callsAllowedFor(tier);
    const used = await readNumber(`calls:${identity}:${monthKey()}`);
    return {
        used,
        limit,
        remaining: Math.max(0, limit - used),
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
export async function admit(identity, tier = 'anon') {
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

    const burst = await addNumber(`burst:${identity}`, 1, BURST_WINDOW_SEC);
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

    const limit = callsAllowedFor(tier);
    const used = await addNumber(`calls:${identity}:${monthKey()}`, 1, secondsLeftInMonth());
    if (used > limit) {
        const upsell = tier === 'anon'
            ? ' Signing in with Discord raises the limit, or add your own API key in the mod settings.'
            : ' Add your own API key in the mod settings to keep going.';
        return {
            ok: false,
            code: 'quota_exhausted',
            status: 402,
            message: `Monthly limit reached (${limit} calls).${upsell}`
        };
    }

    return { ok: true, used, remaining: Math.max(0, limit - used) };
}
