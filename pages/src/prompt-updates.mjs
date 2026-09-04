/**
 * Picking up improved announcer voices from the service.
 *
 * WHY THIS EXISTS. A Sauce mod only updates when a rider downloads a new zip.
 * A rider on the hosted service is already current -- the service substitutes
 * the system prompt at call time -- but a rider on their own API key builds the
 * request themselves, so without this an improved voice reaches them never.
 *
 * WHAT IT WILL NOT DO. It never touches a prompt a rider wrote. Built-in voices
 * are not copied into their settings at all (see prompt-library.mjs), so an
 * improvement is picked up by reading the cache; a copy someone made is their
 * text and stays their text.
 *
 * PRIVACY. The request carries no token, no account, no athlete id and no query
 * string -- a bare conditional GET. It is one call a day, and `promptUpdates`
 * turns it off entirely, in which case the mod runs on its bundled voices
 * forever with nothing else degraded.
 *
 * Like prompt-library.mjs, everything here takes its dependencies as arguments:
 * the store, `fetch`, and the clock. That is what lets the tests drive a whole
 * 304 round trip without a network or a DOM.
 */

import { BUILTIN_PROMPTS } from './prompts.mjs';
import { CACHE_KEY, readCache, builtins } from './prompt-library.mjs';

export const UPDATES_KEY = 'promptUpdates';
export const NOTICE_KEY = 'promptUpdateNotice';

/** Once a day is plenty: these change a few times a year at most. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** A slow service must never hold up a settings window. */
export const FETCH_TIMEOUT_MS = 6000;

/**
 * Where to ask. The hosted service's own URL when a rider has set one,
 * otherwise the public deployment -- a rider on their own API key has no reason
 * to have filled that field in.
 */
export const DEFAULT_SERVICE_URL = 'https://gottabikesaucelunatic-production.up.railway.app';

export function serviceUrlFor(store) {
    const raw = String(store.get('hostedBaseUrl') || '').trim();
    return (raw || DEFAULT_SERVICE_URL).replace(/\/+$/, '');
}

export function updatesEnabled(store) {
    // Default on: it is the only way an installed zip ever improves, and the
    // request is anonymous. One click on the Prompts tab turns it off.
    return (store.get(UPDATES_KEY) ?? 'auto') !== 'off';
}

export function shouldCheck(store, now = Date.now()) {
    if (!updatesEnabled(store)) return false;
    const cached = readCache(store);
    if (!cached) return true;
    // A clock that has gone backwards (a laptop waking in another timezone,
    // a bad NTP step) would otherwise wedge the check until it caught up.
    const age = now - cached.fetchedAt;
    return age < 0 || age >= CHECK_INTERVAL_MS;
}

/**
 * What changed between the voices in force and a freshly fetched set.
 * Reported to the rider; also the reason to bother re-rendering.
 */
function diffAgainst(store, incoming) {
    const before = readCache(store)?.items || {};
    const current = id => before[id] || BUILTIN_PROMPTS[id];
    const updated = [];
    const added = [];
    for (const p of incoming) {
        const now = current(p.id);
        if (!now) added.push({ id: p.id, label: p.label });
        else if (now.version !== p.version) {
            updated.push({ id: p.id, label: p.label, from: now.version, to: p.version,
                changelog: p.changelog || '' });
        }
    }
    return { updated, added };
}

/**
 * One conditional GET.
 *
 * Returns a status rather than throwing, because every outcome here is
 * ordinary: turned off, checked recently, nothing changed, unreachable. Only
 * 'updated' is worth telling the rider about.
 *
 * @returns {Promise<{status: 'off'|'skipped'|'unchanged'|'updated'|'failed',
 *                    updated?: object[], added?: object[], error?: string}>}
 */
export async function checkForUpdates(store, {
    fetchImpl = globalThis.fetch,
    now = Date.now(),
    force = false
} = {}) {
    if (!updatesEnabled(store)) return { status: 'off' };
    if (!force && !shouldCheck(store, now)) return { status: 'skipped' };

    const url = `${serviceUrlFor(store)}/v1/prompts`;
    const cached = readCache(store);

    let res;
    try {
        const headers = {};
        // A conditional request, so an unchanged table costs a 304 and no body.
        if (cached?.etag) headers['If-None-Match'] = cached.etag;
        res = await fetchImpl(url, {
            method: 'GET',
            headers,
            // No credentials, no token, no query string. Nothing identifies who
            // is asking, and nothing should start doing so later by accident.
            cache: 'no-store',
            signal: timeoutSignal()
        });
    } catch (err) {
        return { status: 'failed', error: err?.message || 'unreachable' };
    }

    if (res.status === 304) {
        // Still fresh: restamp so the next check waits another day rather than
        // re-asking on every window open.
        if (cached) touch(store, now);
        return { status: 'unchanged' };
    }
    if (!res.ok) return { status: 'failed', error: `service returned ${res.status}` };

    let body;
    try {
        body = await res.json();
    } catch (err) {
        return { status: 'failed', error: 'the service sent something unreadable' };
    }
    if (!body || !Array.isArray(body.data) || !body.data.length) {
        return { status: 'failed', error: 'the service sent no voices' };
    }

    const changes = diffAgainst(store, body.data);

    // Keep what each changed voice said before, so the notice can show a diff.
    // Carried forward across successive updates until the notice is dismissed:
    // two checks a day apart should still diff against what the rider last saw,
    // not against the intermediate text they never read.
    const before = builtins(store);
    const previous = { ...(readCache(store)?.previous || {}) };
    for (const u of changes.updated) {
        if (!previous[u.id] && before[u.id]) {
            previous[u.id] = {
                version: before[u.id].version,
                systemPrompt: before[u.id].systemPrompt,
                userPromptTemplate: before[u.id].userPromptTemplate
            };
        }
    }

    store.set(CACHE_KEY, {
        data: body.data,
        previous,
        revision: String(body.revision || ''),
        etag: String(res.headers?.get?.('etag') || ''),
        fetchedAt: now
    });

    // Validation happens on read, so confirm the write actually left something
    // usable rather than reporting success over a payload that will be dropped.
    if (!readCache(store)) {
        store.set(CACHE_KEY, cached ? rawOf(cached) : null);
        return { status: 'failed', error: 'the service sent no usable voices' };
    }

    if (changes.updated.length || changes.added.length) {
        store.set(NOTICE_KEY, { ...changes, at: now });
        return { status: 'updated', ...changes };
    }
    return { status: 'unchanged' };
}

/** Re-serialize a validated cache back into its stored shape. */
function rawOf(cached) {
    return {
        data: Object.entries(cached.items).map(([id, p]) => ({ id, ...p })),
        previous: cached.previous,
        revision: cached.revision,
        etag: cached.etag,
        fetchedAt: cached.fetchedAt
    };
}

function touch(store, now) {
    const raw = store.get(CACHE_KEY);
    if (raw && typeof raw === 'object') store.set(CACHE_KEY, { ...raw, fetchedAt: now });
}

/** AbortSignal.timeout where it exists; undefined is a valid signal elsewhere. */
function timeoutSignal() {
    try {
        return AbortSignal.timeout?.(FETCH_TIMEOUT_MS);
    } catch {
        return undefined;
    }
}

/** The pending "voices updated" notice, if one has not been dismissed. */
export function pendingNotice(store) {
    const n = store.get(NOTICE_KEY);
    if (!n || typeof n !== 'object') return null;
    const updated = Array.isArray(n.updated) ? n.updated : [];
    const added = Array.isArray(n.added) ? n.added : [];
    if (!updated.length && !added.length) return null;
    return { updated, added };
}

/**
 * Dismissing also drops the retained previous text: it exists only to render
 * the diff behind this notice, and a settings bag should not carry a second
 * copy of the prompt table forever.
 */
export function dismissNotice(store) {
    store.set(NOTICE_KEY, null);
    const raw = store.get(CACHE_KEY);
    if (raw && typeof raw === 'object' && raw.previous) {
        store.set(CACHE_KEY, { ...raw, previous: {} });
    }
}

/** One line a person can read, for the notice at the top of the Prompts tab. */
export function describeNotice(notice) {
    if (!notice) return '';
    const bits = [];
    const names = list => list.map(v => v.label).join(', ');
    if (notice.updated.length) {
        bits.push(`${notice.updated.length === 1 ? 'One voice was' : `${notice.updated.length} voices were`} ` +
            `improved (${names(notice.updated)})`);
    }
    if (notice.added.length) {
        bits.push(`${notice.added.length === 1 ? 'a new voice is' : `${notice.added.length} new voices are`} ` +
            `available (${names(notice.added)})`);
    }
    // Copies stay untouched, and that is the reassurance worth spending a
    // clause on -- it is the thing a rider would otherwise worry about.
    return `${bits.join(', and ')}. Anything you wrote yourself is unchanged.`;
}
