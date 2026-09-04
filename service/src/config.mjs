/**
 * Configuration, all from environment variables.
 *
 * The one idea worth understanding here is the MODEL ALIAS. Clients never name
 * an upstream model. They ask for `free-fast`, and this file maps that to a
 * real provider and model id. That decoupling means upstream models can be
 * swapped, repriced or retired without shipping a new version of the mod --
 * which matters a lot, because a Sauce mod updates only when a user downloads
 * a new zip.
 */

const env = process.env;

function num(name, fallback) {
    const v = Number(env[name]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
}

function str(name, fallback = '') {
    const v = env[name];
    return typeof v === 'string' && v.trim() ? v.trim() : fallback;
}

export const PORT = num('PORT', 8080);

// Comma-separated list of origins allowed to call this service, or '*'.
// The mod runs inside Sauce4Zwift's Electron renderer, whose origin is a
// localhost URL that varies by install, so '*' is the practical default. The
// endpoint is bearer-authenticated, so a permissive origin does not by itself
// grant anyone anything.
export const ALLOWED_ORIGIN = str('ALLOWED_ORIGIN', '*');

// ---------------------------------------------------------------------------
// The three free models
// ---------------------------------------------------------------------------
// Aliases are the public contract. Upstream ids are an implementation detail
// and are meant to be overridden per-deployment without a code change.
//
// Only the Anthropic default is pinned to a verified id. The other two are
// deliberately blank-by-default: set them to whatever your account actually has
// access to. An alias with no upstream model configured is simply not offered,
// so a half-configured deployment degrades to fewer models rather than to
// runtime 404s the user cannot diagnose.

/**
 * Resolve an alias's key: its own variable first, then a shared per-provider
 * one. Running all three aliases on Anthropic is a normal setup, and without
 * the provider-aware fallback it would mean pasting the same secret into three
 * variables. `fallbackVar` stays as the slot's historical default for the
 * non-Anthropic case.
 */
function keyFor(prefix, provider, fallbackVar) {
    return str(`${prefix}_API_KEY`) ||
        (provider === 'anthropic' ? str('ANTHROPIC_API_KEY') : str(fallbackVar));
}

const FAST_PROVIDER = str('FAST_PROVIDER', 'anthropic');
const BALANCED_PROVIDER = str('BALANCED_PROVIDER', 'openai');
const COLOUR_PROVIDER = str('COLOUR_PROVIDER', 'openai');

// Base URLs default to the provider each slot was originally aimed at. Point a
// slot at Anthropic and you must BLANK its base URL, or the request is built
// for the wrong API. An Anthropic-provider slot ignores it either way, but the
// blank keeps the config honest about where the call goes.
export const MODEL_ALIASES = {
    'free-fast': {
        label: 'Fast',
        description: 'Lowest latency. The commentary starts talking soonest.',
        provider: FAST_PROVIDER,
        model: str('FAST_MODEL', 'claude-haiku-4-5-20251001'),
        baseUrl: str('FAST_BASE_URL'),
        apiKey: keyFor('FAST', FAST_PROVIDER, 'ANTHROPIC_API_KEY')
    },
    'free-balanced': {
        label: 'Balanced',
        description: 'A better turn of phrase, at slightly higher latency.',
        provider: BALANCED_PROVIDER,
        model: str('BALANCED_MODEL'),
        baseUrl: BALANCED_PROVIDER === 'anthropic' ? '' : str('BALANCED_BASE_URL', 'https://api.openai.com/v1'),
        apiKey: keyFor('BALANCED', BALANCED_PROVIDER, 'OPENAI_API_KEY')
    },
    'free-colour': {
        label: 'Colour',
        description: 'The most characterful of the three. Slowest to first word.',
        provider: COLOUR_PROVIDER,
        model: str('COLOUR_MODEL'),
        baseUrl: COLOUR_PROVIDER === 'anthropic' ? '' : str('COLOUR_BASE_URL', 'https://generativelanguage.googleapis.com/v1beta/openai'),
        apiKey: keyFor('COLOUR', COLOUR_PROVIDER, 'GOOGLE_API_KEY')
    }
};

/**
 * Models that cannot work at this output cap, whatever else is configured.
 *
 * Fable and Mythos have thinking permanently on and reject
 * `thinking: {type:'disabled'}` with a 400. With a 60-120 token ceiling the
 * reasoning would consume the entire budget anyway, so there is no setting
 * that makes them viable here.
 *
 * Refusing them at config time matches how a missing key is handled: the alias
 * is simply not offered, /healthz shows it missing and the smoke test warns —
 * rather than every rider who picks it getting a 400 mid-race.
 */
function modelIsUsable(provider, model) {
    if (provider !== 'anthropic') return true;
    const id = String(model).toLowerCase();
    return !(id.includes('fable') || id.includes('mythos'));
}

const warnedAliases = new Set();

/** Aliases that are actually usable: a model id, a key, and a viable model. */
export function availableAliases() {
    return Object.entries(MODEL_ALIASES)
        .filter(([id, a]) => {
            if (!a.model || !a.apiKey) return false;
            if (!modelIsUsable(a.provider, a.model)) {
                // Once per process, not per request.
                if (!warnedAliases.has(id)) {
                    warnedAliases.add(id);
                    console.error(`[config] ${id} is not offered: "${a.model}" cannot disable ` +
                        'thinking, so it returns nothing at this output cap. Use a Sonnet, Opus ' +
                        'or Haiku model.');
                }
                return false;
            }
            return true;
        })
        .map(([id, a]) => ({ id, ...a }));
}

export function resolveAlias(id) {
    const a = MODEL_ALIASES[id];
    if (!a || !a.model || !a.apiKey) return null;
    if (!modelIsUsable(a.provider, a.model)) return null;
    return { id, ...a };
}

export const DEFAULT_ALIAS = str('DEFAULT_MODEL_ALIAS', 'free-fast');

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------
// Every one of these exists to bound what a free request can cost. They are not
// defensive extras; they are the reason the free tier can exist at all.

/** Hard ceiling on output tokens, whatever the client asks for. */
export const MAX_OUTPUT_TOKENS = num('MAX_OUTPUT_TOKENS', 120);

/** Reject oversized prompts. A real race payload is ~4KB; 16KB is generous. */
export const MAX_PROMPT_CHARS = num('MAX_PROMPT_CHARS', 16000);

/** Free calls per identity per rolling month. ~150 is about one racing hour. */
export const FREE_CALLS_PER_MONTH = num('FREE_CALLS_PER_MONTH', 150);

/**
 * Allowance for a signed-in Discord account. Deliberately larger than the
 * anonymous one: signing in has to be worth doing, and an account is an
 * identity that cannot be reset by clearing storage — which is exactly what an
 * anonymous device token can do. The extra allowance is cheap and buys a real,
 * de-duplicated user count.
 */
export const ACCOUNT_CALLS_PER_MONTH = num('ACCOUNT_CALLS_PER_MONTH', 400);

export function callsAllowedFor(tier) {
    if (tier === 'free' || tier === 'paid') return ACCOUNT_CALLS_PER_MONTH;
    return FREE_CALLS_PER_MONTH;
}

/** Short-window burst cap, mirroring the mod's own 8-per-60s spend cap. */
export const BURST_CALLS = num('BURST_CALLS', 10);
export const BURST_WINDOW_SEC = num('BURST_WINDOW_SEC', 60);

/**
 * The global spend breaker, in USD per UTC day.
 *
 * Per-identity quotas do not protect you from a thousand users each behaving
 * perfectly normally. This is the only limit that bounds the bill, and it is
 * the single most important setting in this file. When the day's spend crosses
 * it, free requests are refused with a message telling users to configure their
 * own API key -- which the mod fully supports, so nobody is left stranded.
 */
export const DAILY_BUDGET_USD = num('DAILY_BUDGET_USD', 5);

/**
 * Cost per 1M tokens, used only to run the breaker. These do not need to be
 * exact -- they need to be no LOWER than reality, or the breaker trips late.
 */
export const COST_PER_1M = {
    input: num('COST_INPUT_PER_1M', 1),
    output: num('COST_OUTPUT_PER_1M', 5)
};

export const REDIS_URL = str('REDIS_URL');

/**
 * Discord OAuth. All three must be set for sign-in to be offered at all;
 * `hasAccounts()` is the single switch the rest of the service asks.
 */
export const DISCORD_CLIENT_ID = str('DISCORD_CLIENT_ID');
export const DISCORD_CLIENT_SECRET = str('DISCORD_CLIENT_SECRET');
export const DISCORD_REDIRECT_URI = str('DISCORD_REDIRECT_URI');

/**
 * Discord's API root. Configurable so the OAuth exchange can be exercised
 * against a stand-in during testing; there is no reason to change it in
 * production. Only the API base moves — the authorize URL a rider's browser
 * visits is always the real discord.com.
 */
export const DISCORD_API_BASE = str('DISCORD_API_BASE', 'https://discord.com/api').replace(/\/+$/, '');

export function hasAccounts() {
    return !!(DISCORD_CLIENT_ID && DISCORD_CLIENT_SECRET && DISCORD_REDIRECT_URI);
}

/**
 * Public origin, used to build the sign-in link the mod opens in a browser.
 *
 * Derived from the registered redirect URI rather than configured separately —
 * Discord requires that URI to match exactly, so it is already the one value
 * guaranteed to be correct. PUBLIC_URL overrides it if the service is ever
 * fronted by a different hostname.
 */
export function publicUrl() {
    const explicit = str('PUBLIC_URL');
    if (explicit) return explicit.replace(/\/+$/, '');
    if (DISCORD_REDIRECT_URI) {
        try {
            return new URL(DISCORD_REDIRECT_URI).origin;
        } catch { /* fall through */ }
    }
    return '';
}

/** Signing secret for device tokens. Generated per-boot if unset. */
export const TOKEN_SECRET = str('TOKEN_SECRET');
