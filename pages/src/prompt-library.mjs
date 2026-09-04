/**
 * The rider's own prompts.
 *
 * Built-in voices live in prompts.mjs and are NEVER copied in here. The mod
 * reads their text straight from that table, so improving one is automatic and
 * there is no stale copy to reconcile -- which is the whole reason a rider's
 * copy can be left untouched by an update (see docs/prompt-library-plan.md).
 * This file holds only what a rider wrote.
 *
 * Every function takes the settings store as its first argument rather than
 * reaching for Sauce's `common`. That keeps the module free of the host, so the
 * tests drive it directly instead of through a DOM.
 *
 * The active voice stays in `stylePreset`, widened to hold either a built-in id
 * or a 'usr-' one. A separate `activePromptId` key was the plan, but it would
 * have meant a second migration, a second legacy key, and a worse downgrade: a
 * v0.5.0 build reading a 'usr-' id falls back to Tour de France, whereas it
 * would have read a stale `stylePreset` and picked some unrelated voice.
 */

import { BUILTIN_PROMPTS, DEFAULT_PROMPT_ID, promptFor } from './prompts.mjs';

export const LIBRARY_KEY = 'promptLibrary';
export const ACTIVE_KEY = 'stylePreset';

/**
 * Improved built-in voices fetched from the service, cached locally.
 *
 * `prompts.mjs` stays the BUNDLED FLOOR: if this cache is empty, invalid, or
 * the service has never been reachable, the mod runs on the voices it shipped
 * with. Nothing here is required for the mod to work.
 */
export const CACHE_KEY = 'builtinPrompts';

/**
 * Bounds, because this is localStorage behind Sauce's settingsStore and a
 * settings bag that will not serialize takes every other setting down with it.
 * Both are enforced on save with a message a person can act on, never silently.
 */
export const MAX_USER_PROMPTS = 20;
export const MAX_PROMPT_CHARS = 16000;
export const MAX_NAME_CHARS = 60;

/**
 * Whether one fetched voice is fit to send.
 *
 * This text goes into a rider's OWN paid API call, so it is validated as
 * untrusted input even though it comes from our own service: a truncated
 * response, a proxy that rewrote the body, or a half-written deploy should
 * leave the bundled voice in place rather than send something broken to
 * Anthropic on someone else's bill.
 *
 * Deliberately not a schema check of the whole payload: one bad entry is
 * dropped and the rest are kept, because a new voice with a typo should not
 * cost everyone the improved ones alongside it.
 */
function validBuiltin(p) {
    if (!p || typeof p !== 'object') return false;
    if (typeof p.id !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(p.id)) return false;
    // A 'usr-' id from the service would collide with a rider's own prompts.
    if (isUserPromptId(p.id)) return false;
    if (!Number.isInteger(p.version) || p.version < 1) return false;
    for (const f of ['label', 'description']) {
        if (typeof p[f] !== 'string' || !p[f].trim() || p[f].length > 200) return false;
    }
    for (const f of ['systemPrompt', 'userPromptTemplate']) {
        if (typeof p[f] !== 'string' || !p[f].trim() || p[f].length > MAX_PROMPT_CHARS) return false;
    }
    return true;
}

/** The cached payload, or null if there is nothing usable stored. */
export function readCache(store) {
    const raw = store.get(CACHE_KEY);
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.data)) return null;
    const items = {};
    for (const p of raw.data) {
        if (validBuiltin(p)) {
            items[p.id] = {
                version: p.version,
                label: p.label,
                description: p.description,
                systemPrompt: p.systemPrompt,
                userPromptTemplate: p.userPromptTemplate,
                changelog: typeof p.changelog === 'string' ? p.changelog : ''
            };
        }
    }
    if (!Object.keys(items).length) return null;
    return {
        items,
        revision: String(raw.revision || ''),
        etag: String(raw.etag || ''),
        fetchedAt: Number(raw.fetchedAt) || 0
    };
}

/**
 * The built-in voices actually in force: what the service last sent, over what
 * the mod shipped with.
 *
 * A bundled voice the service no longer lists is KEPT. Removing it would break
 * a rider who is on it, for no gain -- and the service dropping a voice is far
 * more likely to be a half-configured deploy than a deliberate retirement.
 */
export function builtins(store) {
    const cached = readCache(store);
    if (!cached) return BUILTIN_PROMPTS;
    return { ...BUILTIN_PROMPTS, ...cached.items };
}

export function builtinFor(store, id) {
    const table = builtins(store);
    return table[id] || table[DEFAULT_PROMPT_ID] || promptFor(DEFAULT_PROMPT_ID);
}

/** Built-ins for the picker, in the bundled order with new arrivals appended. */
export function listBuiltins(store) {
    const table = builtins(store);
    const ordered = [
        ...Object.keys(BUILTIN_PROMPTS),
        ...Object.keys(table).filter(id => !BUILTIN_PROMPTS[id])
    ];
    return ordered.map(id => ({
        id,
        version: table[id].version,
        label: table[id].label,
        description: table[id].description
    }));
}

/** Thrown for anything a rider can fix by typing something different. */
export class PromptError extends Error {}

const USER_ID = /^usr-[a-z0-9]{6}$/;

export function isUserPromptId(id) {
    return USER_ID.test(String(id));
}

function newId(items) {
    for (let i = 0; i < 50; i++) {
        const id = `usr-${Math.random().toString(36).slice(2, 8).padEnd(6, '0')}`;
        if (!items[id]) return id;
    }
    // Effectively unreachable at 20 items out of 36^6, but silently reusing an
    // id would overwrite someone's prompt.
    throw new PromptError('Could not allocate a prompt id. Delete one and try again.');
}

/**
 * Read the library, tolerating anything. A settings bag can carry whatever a
 * previous build, a hand edit or a partial write left behind, and a prompt
 * editor that throws on load is a prompt editor nobody can use to fix it.
 */
export function readLibrary(store) {
    const raw = store.get(LIBRARY_KEY);
    const items = {};
    if (raw && typeof raw === 'object' && raw.items && typeof raw.items === 'object') {
        for (const [id, p] of Object.entries(raw.items)) {
            if (!isUserPromptId(id) || !p || typeof p !== 'object') continue;
            items[id] = {
                id,
                name: String(p.name || 'Untitled'),
                systemPrompt: String(p.systemPrompt || ''),
                userPromptTemplate: String(p.userPromptTemplate || ''),
                from: p.from && builtins(store)[p.from.id]
                    ? { id: p.from.id, version: Number(p.from.version) || 1 }
                    : null,
                updatedAt: Number(p.updatedAt) || 0
            };
        }
    }
    return { version: 1, items };
}

function write(store, items) {
    store.set(LIBRARY_KEY, { version: 1, items });
}

/** The rider's prompts, most recently edited first. */
export function listUserPrompts(store) {
    return Object.values(readLibrary(store).items)
        .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The id in use, falling back rather than ever returning something unusable. */
export function activeId(store) {
    const stored = store.get(ACTIVE_KEY);
    if (isUserPromptId(stored) && readLibrary(store).items[stored]) return stored;
    if (builtins(store)[stored]) return stored;
    return DEFAULT_PROMPT_ID;
}

/**
 * Everything the editor and the request builder need, for either kind.
 * `readOnly` is the single fact the UI branches on.
 */
export function resolvePrompt(store, id = activeId(store)) {
    const own = readLibrary(store).items[id];
    if (own) {
        return {
            id, kind: 'user', readOnly: false,
            name: own.name,
            description: own.from
                ? `Your own, started from ${builtinFor(store, own.from.id).label}.`
                : 'Your own, written from scratch.',
            systemPrompt: own.systemPrompt,
            userPromptTemplate: own.userPromptTemplate,
            from: own.from
        };
    }
    const table = builtins(store);
    const builtinId = table[id] ? id : DEFAULT_PROMPT_ID;
    const builtin = table[builtinId] || promptFor(DEFAULT_PROMPT_ID);
    return {
        id: builtinId, kind: 'builtin', readOnly: true,
        name: builtin.label,
        description: builtin.description,
        systemPrompt: builtin.systemPrompt,
        userPromptTemplate: builtin.userPromptTemplate,
        from: null
    };
}

/**
 * The voice to ask the hosted service for. It only knows built-ins, and on the
 * free tier it substitutes the system prompt anyway -- so a rider running their
 * own version of Lunatic hears Lunatic there, rather than the default.
 */
export function hostedStyleFor(store, id = activeId(store)) {
    const p = resolvePrompt(store, id);
    if (p.kind === 'builtin') return p.id;
    return p.from?.id || DEFAULT_PROMPT_ID;
}

export function setActive(store, id) {
    store.set(ACTIVE_KEY, id);
}

function validate(store, { name, systemPrompt, userPromptTemplate }, existingId) {
    const n = String(name ?? '').trim();
    if (!n) throw new PromptError('Give the prompt a name.');
    if (n.length > MAX_NAME_CHARS) {
        throw new PromptError(`Names are limited to ${MAX_NAME_CHARS} characters.`);
    }
    for (const [label, text] of [['System message', systemPrompt], ['User template', userPromptTemplate]]) {
        if (String(text ?? '').length > MAX_PROMPT_CHARS) {
            throw new PromptError(
                `${label} is too long — ${MAX_PROMPT_CHARS.toLocaleString()} characters at most.`);
        }
    }
    if (!String(systemPrompt ?? '').trim()) {
        throw new PromptError('The system message cannot be empty — it is what sets the voice.');
    }
    const clash = Object.values(readLibrary(store).items)
        .find(p => p.id !== existingId && p.name.toLowerCase() === n.toLowerCase());
    if (clash) throw new PromptError(`You already have a prompt called “${clash.name}”.`);
    return n;
}

export function createPrompt(store, { name, systemPrompt, userPromptTemplate, from = null }) {
    const { items } = readLibrary(store);
    if (Object.keys(items).length >= MAX_USER_PROMPTS) {
        throw new PromptError(
            `That is the limit of ${MAX_USER_PROMPTS} saved prompts. Delete one to make room.`);
    }
    const clean = validate(store, { name, systemPrompt, userPromptTemplate });
    const id = newId(items);
    items[id] = {
        id, name: clean,
        systemPrompt: String(systemPrompt),
        userPromptTemplate: String(userPromptTemplate || builtinFor(store, DEFAULT_PROMPT_ID).userPromptTemplate),
        from: from && builtins(store)[from.id] ? { id: from.id, version: from.version } : null,
        updatedAt: Date.now()
    };
    write(store, items);
    return id;
}

export function updatePrompt(store, id, patch) {
    const { items } = readLibrary(store);
    const cur = items[id];
    if (!cur) throw new PromptError('That prompt no longer exists.');
    const next = { ...cur, ...patch };
    next.name = validate(store, next, id);
    items[id] = { ...next, id, updatedAt: Date.now() };
    write(store, items);
    return items[id];
}

/** Copy a built-in, or one of the rider's own, into a new editable prompt. */
export function duplicatePrompt(store, sourceId) {
    const src = resolvePrompt(store, sourceId);
    const taken = new Set(Object.values(readLibrary(store).items).map(p => p.name.toLowerCase()));
    // Copying a copy should give "Lunatic (copy 2)", not "Lunatic (copy) (copy)".
    const base = src.name.replace(/\s*\(copy(?: \d+)?\)$/, '');
    let name = `${base} (copy)`;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} (copy ${n})`;
    return createPrompt(store, {
        name,
        systemPrompt: src.systemPrompt,
        userPromptTemplate: src.userPromptTemplate,
        // Provenance follows the original built-in through a chain of copies, so
        // "reset to source" still means something two duplicates deep.
        from: src.kind === 'builtin'
            ? { id: src.id, version: builtinFor(store, src.id).version }
            : src.from
    });
}

export function newBlankPrompt(store) {
    const taken = new Set(Object.values(readLibrary(store).items).map(p => p.name.toLowerCase()));
    let name = 'My prompt';
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `My prompt ${n}`;
    return createPrompt(store, {
        name,
        // Not empty: an empty system message is rejected by validate(), and a
        // blank page is a worse start than one line to replace.
        systemPrompt: 'You are a live bike-race commentator. One sentence, occasionally two.',
        userPromptTemplate: builtinFor(store, DEFAULT_PROMPT_ID).userPromptTemplate,
        from: null
    });
}

/** Delete, and return the id that should now be active. */
export function deletePrompt(store, id) {
    const { items } = readLibrary(store);
    if (!items[id]) throw new PromptError('That prompt no longer exists.');
    const wasActive = activeId(store) === id;
    delete items[id];
    write(store, items);
    if (!wasActive) return activeId(store);
    const next = Object.values(items).sort((a, b) => b.updatedAt - a.updatedAt)[0];
    const fallback = next ? next.id : DEFAULT_PROMPT_ID;
    setActive(store, fallback);
    return fallback;
}

/** Put a copy back to the built-in it came from, keeping its name. */
export function revertToSource(store, id) {
    const own = readLibrary(store).items[id];
    if (!own) throw new PromptError('That prompt no longer exists.');
    if (!own.from) throw new PromptError('This prompt was written from scratch — there is no source to reset to.');
    // Reset to the CURRENT source, not the version they copied: "reset" means
    // "give me the real one", and the improved text is the real one.
    const src = builtinFor(store, own.from.id);
    return updatePrompt(store, id, {
        systemPrompt: src.systemPrompt,
        userPromptTemplate: src.userPromptTemplate,
        from: { id: own.from.id, version: src.version }
    });
}

/**
 * Every prompt-storage migration, once, behind one flag.
 *
 * They have to share a flag and an order. Phase 1 put two of these in
 * migrateModelSetting(), which runs on every window open, and that was wrong
 * twice over: the hosted-voice adoption would fire again any time a rider set
 * their voice back to the default, and the unknown-id reset would have wiped a
 * 'usr-' id the moment the library introduced one.
 *
 * Nothing here needs to run more than once, because activeId() already falls
 * back at read time for anything it does not recognise.
 */
export const MIGRATED_KEY = 'promptLibraryMigrated';

/**
 * Ids that no longer name a voice. 'professional', 'casual' and 'dramatic' were
 * three stored values that all resolved to the same Tour de France prompt, and
 * the dropdown only ever offered the third.
 */
const LEGACY_IDS = { professional: 'tour', casual: 'tour', dramatic: 'tour' };

export function migratePrompts(store) {
    if (store.get(MIGRATED_KEY)) return null;
    store.set(MIGRATED_KEY, true);

    // 1. Legacy voice ids onto canonical ones.
    const stored = store.get(ACTIVE_KEY);
    if (stored && LEGACY_IDS[stored]) setActive(store, LEGACY_IDS[stored]);

    // 2. `hostedStyle` was a second voice picker on the AI Provider tab, from
    //    when the mod and the service named different voices. A hosted-only
    //    choice moves onto the shared key -- but never over a deliberate one.
    const hosted = store.get('hostedStyle');
    if (hosted && hosted !== DEFAULT_PROMPT_ID && builtins(store)[hosted] &&
        (store.get(ACTIVE_KEY) ?? DEFAULT_PROMPT_ID) === DEFAULT_PROMPT_ID) {
        setActive(store, hosted);
    }

    // 3. The old single custom slot becomes a library prompt.
    //
    //    Before the library there was exactly one editable pair,
    //    `customSystemPrompt` / `customUserPrompt`, selected by setting the
    //    voice to the literal 'custom'. Those keys are deliberately NOT deleted:
    //    a rider who downgrades to a build that still reads them should find
    //    their prompt where they left it.
    const system = String(store.get('customSystemPrompt') || '').trim();
    const user = String(store.get('customUserPrompt') || '').trim();
    const wasCustom = store.get(ACTIVE_KEY) === 'custom';

    if (!system) {
        // 'custom' with no text was a selection that silently fell back to the
        // default prompt anyway.
        if (wasCustom) setActive(store, DEFAULT_PROMPT_ID);
        return null;
    }

    let id;
    try {
        id = createPrompt(store, {
            name: 'My prompt',
            systemPrompt: system,
            userPromptTemplate: user || builtinFor(store, DEFAULT_PROMPT_ID).userPromptTemplate,
            from: null
        });
    } catch (err) {
        console.warn('[Lunatic] could not migrate the old custom prompt:', err.message);
        if (wasCustom) setActive(store, DEFAULT_PROMPT_ID);
        return null;
    }
    if (wasCustom) setActive(store, id);
    return id;
}
