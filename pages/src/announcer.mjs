import * as common from '/pages/src/common.mjs';
// Relative specifier: '/pages/src/...' is SAUCE CORE, not this mod, even
// though the mod's own file sits at the same relative path on disk.
import {
    PROVIDERS, DEFAULT_PROVIDER, COMPATIBLE_PRESETS, DEVICE_TOKEN_KEY, QUOTA_KEY, ACCOUNT_KEY,
    ATHLETE_ID_KEY,
    providerFor, presetFor, costFor, streamCompletion, tokenKind
} from './providers.mjs';
import {
    BUILTIN_PROMPTS, DEFAULT_PROMPT_ID, promptFor, listPrompts
} from './prompts.mjs';
import * as library from './prompt-library.mjs';
import * as promptUpdates from './prompt-updates.mjs';
import { diffPrompts } from './prompt-diff.mjs';

// Storage keys (global, shared across windows)
const ATHLETE_DATA_KEY = '/gotta-bike-sauce-athlete-data';
const COMMENTARY_SETTINGS_KEY = '/gotta-bike-lunatic-settings';
// Shared cost counters so the main and settings windows see the same numbers.
const COST_KEY = '/gotta-bike-lunatic-session-cost';
const CALLS_KEY = '/gotta-bike-lunatic-total-calls';


// Background color options
const BACKGROUND_OPTIONS = {
    transparent: { name: 'Transparent', color: null },
    black: { name: 'Black', color: '#000000' },
    sauce: { name: 'Sauce Default', color: '#232323' },
    darkGray: { name: 'Dark Gray', color: '#1a1a1a' },
    darkBlue: { name: 'Dark Blue', color: '#0d1b2a' },
    darkGreen: { name: 'Dark Green', color: '#1a2e1a' },
    custom: { name: 'Custom', color: null }
};

// Model catalogs, request shapes and the streaming loop all live in
// providers.mjs. Kept here only because several call sites still want a plain
// default model id for the Anthropic path.
const DEFAULT_MODEL = PROVIDERS.anthropic.defaultModel;

// ============================================================================
// Active provider
// ============================================================================
// Every "is the AI configured?" check goes through isProviderConfigured(). There
// are seven such gates and one of them -- shouldFireNow() -- returns false with
// no error and no toast, so a provider left half-configured produces an overlay
// that is silently, permanently mute. Route them all through one helper.

function activeProviderId() {
    const id = common.settingsStore.get('aiProvider');
    return PROVIDERS[id] ? id : DEFAULT_PROVIDER;
}

function activeProvider() {
    return providerFor(activeProviderId());
}

/**
 * The voice in use — a built-in id, or one of the rider's own. Resolution and
 * fallback live in prompt-library.mjs; this is just the store-bound wrapper.
 */
function activePromptId() {
    return library.activeId(common.settingsStore);
}

function activeApiKey() {
    return common.settingsStore.get(activeProvider().keySetting) || '';
}

function activeModel() {
    const p = activeProvider();
    return common.settingsStore.get(p.modelSetting) || p.defaultModel;
}

function activeBaseUrl() {
    const p = activeProvider();
    return p.baseUrlSetting ? (common.settingsStore.get(p.baseUrlSetting) || '') : '';
}

function activePresetId() {
    return common.settingsStore.get('compatPreset') || 'openai';
}

/** Enough settings present to make a request at all. */
function isProviderConfigured() {
    return activeProvider().isConfigured(k => common.settingsStore.get(k));
}

/** Settings keys that change whether/where we can call a model. */
const PROVIDER_SETTING_KEYS = [
    'aiProvider', 'claudeApiKey', 'claudeModel',
    'compatApiKey', 'compatModel', 'compatBaseUrl', 'compatPreset',
    'hostedBaseUrl', 'hostedModel', 'hostedStyle', DEVICE_TOKEN_KEY
];

// State
let storedAthleteData = {};
let nearbyData = [];
let groupsData = [];
let watchingAthlete = null;
let isStreaming = false;
let isPaused = true;
// Whether a provider was usable at the last check; startCommentary() fires on
// the false -> true edge. See that function for why this exists.
let providerReady = false;
let updateTimer = null;
let conversationHistory = [];
let commentaryHistory = [];
let sessionCost = 0;
let totalCalls = 0;
let errorTimer = null;
let firstDataFired = false;

// Streaming lifecycle / stall protection
let activeAbort = null;
let streamStartedAt = 0;
let watchdogTimer = null;

// Race context names resolved out-of-band (RPCs are memoized per id, so this is
// one lookup per event/route, not one per tick).
let raceContextNames = { event: null, route: null, laps: null };
let lastContextIds = { sg: null, route: null };

// Change detection: per-athlete rolling samples, pending events, storylines.
const tracks = new Map();
let pendingEvents = [];
const storylines = new Map();
let lastGenerationEnd = 0;
let recentCallTimes = [];

// Text-to-speech
let ttsVoice = null;
let ttsWarmed = false;

// Default settings
common.settingsStore.setDefault({
    fontScale: 1,
    backgroundOption: 'transparent',
    customBackgroundColor: '#232323',
    updateInterval: 45,
    maxRiders: 10,
    historyCount: 3,
    showHistory: true,
    // API settings
    aiProvider: DEFAULT_PROVIDER,
    claudeApiKey: '',
    claudeModel: DEFAULT_MODEL,
    // OpenAI-compatible provider (OpenAI, Gemini, OpenRouter, Groq, Ollama, …)
    compatPreset: 'openai',
    compatBaseUrl: COMPATIBLE_PRESETS.openai.baseUrl,
    compatApiKey: '',
    compatModel: '',
    // Optional USD per 1M tokens, so a free-text model can still be costed.
    compatInputCost: '',
    compatOutputCost: '',
    // Lunatic hosted service. The base URL is per-deployment, so there is no
    // sensible default to ship — the user pastes their own.
    hostedBaseUrl: '',
    hostedModel: 'free-fast',
    // LEGACY. The voice is 'stylePreset' now, for every provider. Kept so the
    // migration below has a defined value to read, and so a downgrade to a build
    // that still reads it finds something sane.
    hostedStyle: DEFAULT_PROMPT_ID,
    maxTokens: 60,
    // Prompt settings
    stylePreset: DEFAULT_PROMPT_ID,
    // Live cadence (event-driven)
    eventDriven: true,
    minInterval: 12,
    // Text-to-speech. ON: the mod's one-line description is "spoken aloud", and
    // a rider who never finds the switch never hears the thing they installed.
    // The speaker button in the overlay titlebar mutes it in one click, and the
    // Status box says so the moment a provider connects.
    ttsEnabled: true,
    ttsVoice: '',
    ttsRate: 1.2,
    ttsPitch: 1.1,
    ttsVolume: 1,
    customSystemPrompt: '',
    customUserPrompt: '',
    // Data field settings - live data. One choice for per-rider power:
    // 'smooth5' (stats.power.smooth[5]), 'instant' (state.power) or 'off'.
    powerMode: 'smooth5',
    sendHeartRate: true,
    sendGap: true,
    sendDraft: true,
    sendSpeed: true,
    sendCadence: false,
    sendPower60s: true,
    // LEGACY. `sendPower` and `sendPower15s` were two independent-looking
    // checkboxes that were really one else-if; migrateDataFields() folds them
    // into powerMode. Never written and never read now -- kept so a downgrade
    // finds what the rider had. sendPower5s, sendPower300s, sendPower1200s,
    // sendCP, sendPowerCurve and sendRouteSuitability were never read by
    // anything and are gone; there is no data shape behind any of them.
    sendPower: true,
    sendPower15s: true,
    // Stored data, from the GOTTA.BIKE Sauce import
    sendFTP: true,
    sendPhenotype: true,
    sendRaceRating: true,
    sendRaceStats: false,
    sendWeight: false
});

const DATA_FIELDS_MIGRATED_KEY = 'dataFieldsMigrated';

/**
 * Fold the old two-checkbox power pair into one `powerMode`.
 *
 * html had "Current Power (watts)" and "5s rolling power", both ticked by
 * default, in two different groups -- and riderLine() read them as
 * `if (sendPower15s) … else if (sendPower)`. So with the defaults "Current
 * Power" did nothing, and unticking "5s rolling" to send LESS switched the
 * announcer to noisier instantaneous power. Map what actually happened:
 * the 5s box wins if it is on, because it did.
 *
 * One shot behind its own flag, in both entry points, like every other
 * migration here. The legacy keys are left exactly as the rider had them.
 */
function migrateDataFields() {
    const store = common.settingsStore;
    if (store.get(DATA_FIELDS_MIGRATED_KEY)) return;

    if (store.get('sendPower15s')) store.set('powerMode', 'smooth5');
    else if (store.get('sendPower')) store.set('powerMode', 'instant');
    else store.set('powerMode', 'off');

    store.set(DATA_FIELDS_MIGRATED_KEY, true);
}

// ============================================================================
// One-time migration from the GOTTA.BIKE sauce build of this window
// ============================================================================
// Sauce scopes a settings bag by window-INSTANCE id -- the real localStorage key
// is `user-<modId>-<windowId>-<ts>-<rand>-<data-settings-key>`. A new mod always
// gets a new random windowID, so settingsStore can NEVER see the old bag no
// matter what we name things. Only a raw localStorage scan recovers the user's
// Anthropic API key. Runs at module load in both windows; the flag no-ops the
// second. Never deletes the legacy entry -- GOTTA.BIKE sauce may still be
// installed and reading it -- and never writes the legacy counter keys, or a
// still-installed GOTTA window would double-count into the same counter.
const MIGRATED_KEY = '/gotta-bike-lunatic-migrated';
const LEGACY_BAG_SUFFIX = '-live-commentary-settings-v1';
const LEGACY_COST_KEY = '/gotta-bike-sauce-commentary-session-cost';
const LEGACY_CALLS_KEY = '/gotta-bike-sauce-commentary-total-calls';

function migrateLegacySettings() {
    try {
        if (common.settingsStore.get(MIGRATED_KEY)) return;
        if (common.settingsStore.get('claudeApiKey')) {
            common.settingsStore.set(MIGRATED_KEY, true);
            return;
        }
        const candidates = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (!k || !k.endsWith(LEGACY_BAG_SUFFIX)) continue;
            let bag;
            try { bag = JSON.parse(localStorage.getItem(k)); } catch (e) { continue; }
            if (!bag || typeof bag !== 'object' || !bag.claudeApiKey) continue;
            const m = k.match(/-(\d{10,})-\d+-/);   // windowID: ...-<ts>-<rand>-
            candidates.push({
                bag,
                ts: m ? Number(m[1]) : 0,
                gotta: k.includes('GOTTA_BIKE_sauce') ? 1 : 0,
            });
        }
        if (candidates.length) {
            candidates.sort((a, b) => (b.gotta - a.gotta) || (b.ts - a.ts));
            common.settingsStore.set(null, candidates[0].bag);
            console.info('[Lunatic] recovered settings from a previous Live Commentary window');
        }
        const c = common.settingsStore.get(LEGACY_COST_KEY);
        if (c && !common.settingsStore.get(COST_KEY)) common.settingsStore.set(COST_KEY, c);
        const n = common.settingsStore.get(LEGACY_CALLS_KEY);
        if (n && !common.settingsStore.get(CALLS_KEY)) common.settingsStore.set(CALLS_KEY, n);
        common.settingsStore.set(MIGRATED_KEY, true);
    } catch (e) {
        console.warn('[Lunatic] legacy settings migration skipped:', e);
    }
}
migrateLegacySettings();


// ============================================================================
// Main Window Functions
// ============================================================================

/**
 * Main entry point for Live Commentary window
 */
export async function lunaticAnnouncerMain() {
    common.initInteractionListeners();

    // Load stored data. The prompt migrations run first and once, so the overlay
    // uses the same voice the settings window would show -- a rider who never
    // opens settings after upgrading still gets their own prompt back.
    library.migratePrompts(common.settingsStore);
    migrateModelSetting();
    migrateDataFields();
    loadStoredAthleteData();
    sessionCost = common.settingsStore.get(COST_KEY) || 0;
    totalCalls = common.settingsStore.get(CALLS_KEY) || 0;

    // Apply settings
    const fontScale = common.settingsStore.get('fontScale') || 1;
    document.documentElement.style.setProperty('--font-scale', fontScale);
    applyBackground();

    // Setup UI
    setupMainWindowUI();
    updateApiStatus();
    updatePauseButton();
    renderCost();
    initTTS();
    warmTTS();

    // Watchdog: independent of the update timer, because that timer does not
    // exist in manual mode — which is exactly where a stuck isStreaming flag
    // would also disable the Generate button.
    watchdogTimer = setInterval(clearStuckStream, 5000);

    // Subscribe to nearby data (Sauce ticks this at ~1Hz)
    common.subscribe('nearby', data => {
        if (!data || !data.length) {
            nearbyData = [];
            watchingAthlete = null;
            // Let a refill count as a fresh start rather than waiting out the timer.
            firstDataFired = false;
            return;
        }
        nearbyData = data;
        watchingAthlete = data.find(a => a.watching);
        publishAthleteId(watchingAthlete?.athleteId);

        const now = Date.now();
        refreshRaceContextNames();
        updateTracks(data, now);
        detectEvents(data, now);

        // Fire one commentary as soon as real ride data first arrives instead
        // of waiting a full update interval. Not when the rider has turned off
        // both triggers: "manual only" has to mean it, or the one setting that
        // exists to stop unasked-for calls still makes one every ride.
        if (!firstDataFired && !isPaused && !isStreaming && !isManualOnly() &&
            isProviderConfigured() &&
            nearbyData.some(r => !r.watching)) {
            firstDataFired = true;
            generateCommentary();
            return;
        }

        // Event-driven cadence: fire on what actually happened.
        if (shouldFireNow(now)) {
            generateCommentary();
        }
    });

    // Pack structure, used only for a "shape of the race" line. Additive — if
    // 'groups' is unavailable the commentary simply omits it.
    try {
        common.subscribe('groups', groups => { groupsData = groups || []; });
    } catch (e) {
        console.warn('[Lunatic] groups subscription unavailable:', e);
    }

    // A camera cut invalidates every track, storyline and continuity line.
    try {
        common.subscribe('watching-athlete-change', () => {
            tracks.clear();
            storylines.clear();
            pendingEvents = [];
            conversationHistory = [];
            cooldowns.clear();
            firstDataFired = false;
        });
    } catch (e) { /* older Sauce builds may not emit this */ }

    // Listen for settings changes
    common.settingsStore.addEventListener('changed', ev => {
        const changed = ev.data.changed;
        if (changed.has('fontScale')) {
            document.documentElement.style.setProperty('--font-scale', common.settingsStore.get('fontScale') || 1);
        }
        if (changed.has('backgroundOption') || changed.has('customBackgroundColor')) {
            applyBackground();
        }
        // Any provider setting can flip "configured" — not just the Claude key.
        if (PROVIDER_SETTING_KEYS.some(k => changed.has(k))) {
            updateApiStatus();
            // The first-run edge: a provider just became usable while this
            // window sat paused on the placeholder. Start, once, on that edge
            // only -- not on every provider edit, which would un-pause a rider
            // who paused on purpose.
            const ready = isProviderConfigured();
            if (ready && !providerReady) startCommentary();
            providerReady = ready;
            // The cost readout is provider-shaped: the hosted service shows an
            // allowance, everything else a dollar figure. Without this it keeps
            // the OLD provider's reading until the next call happens to write a
            // counter — showing a spend total while on the free tier, or "free
            // calls left" while burning the rider's own key.
            renderCost();
        }
        if (changed.has('updateInterval') || changed.has('eventDriven')) {
            restartAutoUpdate();
            updatePauseButton();    // the dot describes both triggers
        }
        if (changed.has('ttsVoice')) {
            ttsVoice = pickVoice();
        }
        if (changed.has('ttsEnabled')) {
            updateMuteButton();
            if (!common.settingsStore.get('ttsEnabled')) cancelSpeech();
        }
        if (changed.has('showHistory') || changed.has('historyCount')) {
            renderHistory();
        }
    });

    // Listen for athlete data + shared cost updates
    common.settingsStore.addEventListener('set', ev => {
        if (ev.data.key === ATHLETE_DATA_KEY) {
            storedAthleteData = ev.data.value || {};
        } else if (ev.data.key === QUOTA_KEY) {
            renderCost();
        } else if (ev.data.key === COST_KEY || ev.data.key === CALLS_KEY) {
            // Keep the in-memory accumulator in sync with cross-window changes
            // (e.g. a reset triggered from the settings window).
            if (ev.data.remote) {
                sessionCost = common.settingsStore.get(COST_KEY) || 0;
                totalCalls = common.settingsStore.get(CALLS_KEY) || 0;
            }
            renderCost();
        }
    });

    // Start if a provider is already usable. If not, the settings listener
    // above starts it the moment one becomes usable -- see startCommentary().
    providerReady = isProviderConfigured();
    if (providerReady) startCommentary();
}

/**
 * The moment a provider is usable: replace the "pick a provider" placeholder,
 * restore the saved pause state, and start the scheduler.
 *
 * This used to run only at boot. But the gear lives on the overlay, so on every
 * first run a rider configures their key WITH THIS WINDOW OPEN -- and came back
 * to an overlay still paused, still telling them to pick a provider, with the
 * API dot green. The only ways out were unlabelled: press play, or reopen the
 * window. Now it also runs from the `changed` listener the first time
 * isProviderConfigured() flips to true.
 *
 * `commentaryPaused` is honoured, not overridden: a rider who paused on purpose
 * and then swaps providers should stay paused. Only a rider who was never able
 * to start gets started.
 */
function startCommentary() {
    const ph = document.querySelector('#current-commentary .placeholder-text');
    if (ph) ph.textContent = 'Waiting for ride data…';
    isPaused = common.settingsStore.get('commentaryPaused') ?? false;
    // Let the next real data tick count as a fresh start rather than waiting
    // out a full interval.
    firstDataFired = false;
    updatePauseButton();
    if (!isPaused) restartAutoUpdate();
}

/**
 * Guard against a stored model that this build no longer knows about — e.g. a
 * user who selected an older model before it was retired. A retired model ID
 * returns 404 on every request, which is what silently broke this window twice.
 * Runs in both windows so the settings dropdown and the API caller agree.
 */
function migrateModelSetting() {
    // An unknown provider id — a downgrade after selecting one a later build
    // added — would otherwise reach every call site as undefined.
    const storedProvider = common.settingsStore.get('aiProvider');
    if (storedProvider && !PROVIDERS[storedProvider]) {
        console.warn(`[Lunatic] Unknown provider "${storedProvider}" — falling back to ${DEFAULT_PROVIDER}`);
        common.settingsStore.set('aiProvider', DEFAULT_PROVIDER);
    }

    // Only a provider with a model catalog can validate its stored model, and
    // it must fall back to ITS OWN default — never across providers, or a
    // Google key ends up paired with a Claude model id and 404s every call.
    for (const prov of Object.values(PROVIDERS)) {
        if (!prov.models) continue;
        const stored = common.settingsStore.get(prov.modelSetting);
        if (stored && !prov.models[stored]) {
            console.warn(`[Lunatic] Unknown/retired ${prov.label} model "${stored}" — falling back to ${prov.defaultModel}`);
            common.settingsStore.set(prov.modelSetting, prov.defaultModel);
        }
    }

    // setDefault() is a no-op once a value is stored, so existing users would
    // never pick up the new announcer defaults without an explicit migration.
    if (common.settingsStore.get('maxTokens') === 200) {
        common.settingsStore.set('maxTokens', 60);
    }
    // The mod and the service used to carry different, differently-named voice
    // sets; 'professional', 'casual' and 'dramatic' were three stored values
    // that all resolved to the same Tour de France prompt. Move them onto the
    // canonical ids so the dropdown matches an option and the hosted and BYOK
    // paths finally name the same thing.
}

/**
 * Resolve event/route NAMES, which are not in the nearby payload. Both lookups
 * are memoized per id by Sauce, so this is one RPC per event/route rather than
 * one per tick. The `instanceof Promise` guard is Sauce's own pattern: the first
 * call returns a promise, later calls the object — a tick where it hasn't
 * settled simply omits the name.
 */
function refreshRaceContextNames() {
    const sgId = watchingAthlete?.state?.eventSubgroupId ?? null;
    const routeId = watchingAthlete?.state?.routeId ?? null;
    if (sgId === lastContextIds.sg && routeId === lastContextIds.route) return;
    lastContextIds = { sg: sgId, route: routeId };
    raceContextNames = { event: null, route: null, laps: null };

    try {
        const sg = sgId ? common.getEventSubgroup(sgId) : null;
        if (sg && !(sg instanceof Promise)) {
            raceContextNames.event = sg.name || null;
            raceContextNames.laps = sg.laps > 1 ? sg.laps : null;
        }
        const rid = (sg && !(sg instanceof Promise) && sg.routeId) || routeId;
        const route = rid ? common.getRoute(rid) : null;
        if (route && !(route instanceof Promise)) {
            raceContextNames.route = route.name || null;
        }
    } catch (e) {
        // Never let context lookup break the commentary path.
        console.warn('[Lunatic] race context lookup failed:', e);
    }
}

/**
 * If a stream stalls, `finally` never runs and isStreaming sticks true forever,
 * silently killing all further commentary. Abort rather than just flipping the
 * flag, or an orphan stream keeps writing into the same element.
 */
function clearStuckStream() {
    if (!isStreaming) return;
    const interval = clockSeconds() * 1000;
    if (Date.now() - streamStartedAt > Math.max(30000, interval)) {
        console.warn('[Lunatic] stream watchdog fired — aborting stuck request');
        try { activeAbort?.abort(); } catch (e) { /* ignore */ }
        isStreaming = false;
        document.getElementById('current-commentary')?.classList.remove('streaming');
        document.querySelector('#current-commentary .commentary-text')?.classList.remove('awaiting');
    }
}

function loadStoredAthleteData() {
    storedAthleteData = common.settingsStore.get(ATHLETE_DATA_KEY) || {};
}

function applyBackground() {
    const option = common.settingsStore.get('backgroundOption') || 'transparent';
    const customColor = common.settingsStore.get('customBackgroundColor') || '#232323';

    const body = document.body;
    body.classList.remove('transparent-bg', 'solid-background');

    if (option === 'transparent') {
        body.classList.add('transparent-bg');
    } else {
        body.classList.add('solid-background');
        const bgOption = BACKGROUND_OPTIONS[option];
        const color = option === 'custom' ? customColor : (bgOption?.color || '#000000');
        document.documentElement.style.setProperty('--background-color', color);
    }
}

function setupMainWindowUI() {
    // Generate-now button
    const genBtn = document.getElementById('generate-btn');
    if (genBtn) {
        genBtn.addEventListener('click', () => {
            if (!isStreaming) generateCommentary(true);
        });
    }

    // Mute / speak button
    const muteBtn = document.getElementById('mute-btn');
    if (muteBtn) {
        muteBtn.addEventListener('click', toggleMute);
        updateMuteButton();
    }

    // Pause button
    const pauseBtn = document.getElementById('pause-btn');
    if (pauseBtn) {
        pauseBtn.addEventListener('click', togglePause);
    }

    // Copy button
    const copyBtn = document.getElementById('copy-btn');
    if (copyBtn) {
        copyBtn.addEventListener('click', copyCommentary);
    }

    // Error toast dismiss
    const errorDismiss = document.querySelector('.error-dismiss');
    if (errorDismiss) {
        errorDismiss.addEventListener('click', hideError);
    }
}

function togglePause() {
    isPaused = !isPaused;
    // Remember pause state so re-opening the window doesn't silently resume
    // (and start spending) against the user's wishes.
    common.settingsStore.set('commentaryPaused', isPaused);
    updatePauseButton();

    if (isPaused) {
        stopAutoUpdate();
        // Pause must stop the announcer talking, not just the API timer.
        cancelSpeech();
    } else {
        restartAutoUpdate();
        // Trigger immediate update when resuming (user action)
        generateCommentary(true);
    }
}

function toggleMute() {
    const on = !common.settingsStore.get('ttsEnabled');
    common.settingsStore.set('ttsEnabled', on);
    if (!on) cancelSpeech();
    if (on) warmTTS();
    updateMuteButton();
}

function updateMuteButton() {
    const btn = document.getElementById('mute-btn');
    if (!btn) return;
    const on = !!common.settingsStore.get('ttsEnabled');
    btn.classList.toggle('active', on);
    const icon = btn.querySelector('ms');
    if (icon) icon.textContent = on ? 'volume_up' : 'volume_off';
    btn.title = on ? 'Mute spoken commentary' : 'Speak commentary aloud';
}

/** The longest-silence setting in seconds; 0 means "never on a clock". */
function clockSeconds() {
    return parseInt(common.settingsStore.get('updateInterval') ?? 45, 10) || 0;
}

/**
 * Is nothing going to speak unless the rider presses refresh?
 *
 * BOTH triggers have to be off. The overlay used to call it manual whenever
 * the clock was off, which was a lie with the shipped defaults: race events
 * still fired, up to eight paid calls a minute, under a dot whose tooltip said
 * "Manual only — use the refresh button". Picking that option is exactly what a
 * rider does to stop spending.
 */
function isManualOnly() {
    return !common.settingsStore.get('eventDriven') && clockSeconds() === 0;
}

/** "45 seconds", "2 minutes" — reads after "every", so 60 is "minute". */
function describeClock(secs) {
    if (secs % 60 === 0) {
        const mins = secs / 60;
        return mins === 1 ? 'minute' : `${mins} minutes`;
    }
    return `${secs} seconds`;
}

function updatePauseButton() {
    const pauseBtn = document.getElementById('pause-btn');
    const statusEl = document.getElementById('auto-update-status');

    if (pauseBtn) {
        pauseBtn.classList.toggle('paused', isPaused);
        pauseBtn.classList.toggle('active', !isPaused);

        const icon = pauseBtn.querySelector('ms');
        if (icon) {
            icon.textContent = isPaused ? 'play_arrow' : 'pause';
        }
        // Not "auto-updates": in this mod an update is also the daily voice
        // check and the next zip off the releases page.
        pauseBtn.title = isPaused ? 'Resume the announcer' : 'Pause the announcer';
    }

    if (statusEl) {
        const manual = isManualOnly();
        const clock = clockSeconds();
        statusEl.title = isPaused ? 'Commentary paused'
            : manual ? 'Manual only — use the refresh button'
            : common.settingsStore.get('eventDriven')
                ? (clock ? `Listening for race events, and speaking at least every ${describeClock(clock)}`
                    : 'Listening for race events')
                : `Speaking every ${describeClock(clock)}`;
        statusEl.classList.toggle('paused', isPaused);
        statusEl.classList.toggle('manual', !isPaused && manual);
        statusEl.classList.toggle('active', !isPaused && !manual);
    }
}

/**
 * Publish the watched athlete id for the settings window.
 *
 * Only the overlay subscribes to `nearby`, but the settings window needs the
 * same id to ask /v1/quota about the bucket commentary actually spends from.
 * Written only when it changes: this runs at ~1Hz and every set() wakes both
 * windows' `changed` listeners.
 *
 * Never cleared. A camera cut or an empty tick means "nobody to talk about",
 * not "this rider stopped existing", and the settings window may be opened
 * long after the ride ended -- with no id it would silently go back to asking
 * about the wrong bucket.
 */
function publishAthleteId(id) {
    if (!id) return;
    if (common.settingsStore.get(ATHLETE_ID_KEY) === id) return;
    common.settingsStore.set(ATHLETE_ID_KEY, id);
}

function updateApiStatus() {
    const configured = isProviderConfigured();
    const statusEl = document.getElementById('api-status');

    if (statusEl) {
        // A dot carries the state; the detail lives in the tooltip, since the
        // overlay sits on top of a race and every pixel of chrome is in the way.
        statusEl.title = configured ? `${activeProvider().label} ready` : 'No AI provider configured';
        statusEl.classList.toggle('connected', configured);
        statusEl.classList.toggle('not-configured', !configured);
        statusEl.classList.remove('error');
    }
}

function markApiError(err) {
    const statusEl = document.getElementById('api-status');
    if (!statusEl) return;
    const msg = err?.message || '';
    const likelyConfig = /401|invalid|api[-_ ]?key|authentication|not_found|404/i.test(msg);
    // The dot goes red; the tooltip carries the actual message, which is the
    // only place the real cause was ever visible.
    statusEl.title = (likelyConfig ? 'Check your key or model — ' : 'Last call failed — ') +
        (msg || 'unknown error');
    statusEl.classList.remove('connected', 'not-configured');
    statusEl.classList.add('error');
}

function restartAutoUpdate() {
    stopAutoUpdate();

    // In live-cadence mode the scheduler runs off the 1Hz data tick and already
    // enforces the longest-silence floor, so a second wall-clock timer here
    // would double-fire and bypass the rate limit.
    if (common.settingsStore.get('eventDriven')) return;

    const interval = clockSeconds();
    if (interval > 0 && !isPaused) {
        updateTimer = setInterval(() => {
            if (!isStreaming && !isPaused && !isSpeaking()) {
                generateCommentary();
            }
        }, interval * 1000);
    }
}

function stopAutoUpdate() {
    if (updateTimer) {
        clearInterval(updateTimer);
        updateTimer = null;
    }
}

async function copyCommentary() {
    const copyBtn = document.getElementById('copy-btn');
    const commentaryEl = document.querySelector('#current-commentary .commentary-text');

    if (!commentaryEl) return;

    // Don't copy placeholder/error text (it renders inside a .placeholder-text node).
    if (commentaryEl.querySelector('.placeholder-text')) return;
    const text = commentaryEl.textContent;
    if (!text) return;

    try {
        await navigator.clipboard.writeText(text);
        if (copyBtn) {
            copyBtn.classList.add('copied');
            setTimeout(() => copyBtn.classList.remove('copied'), 1000);
        }
    } catch (err) {
        console.error('Failed to copy:', err);
    }
}

function showError(message) {
    const toast = document.getElementById('error-toast');
    const msgEl = toast?.querySelector('.error-message');

    if (toast && msgEl) {
        msgEl.textContent = message;
        toast.hidden = false;

        // Reset any pending auto-hide so a newer error isn't cut short.
        if (errorTimer) clearTimeout(errorTimer);
        errorTimer = setTimeout(hideError, 8000);
    }
}

function hideError() {
    if (errorTimer) {
        clearTimeout(errorTimer);
        errorTimer = null;
    }
    const toast = document.getElementById('error-toast');
    if (toast) {
        toast.hidden = true;
    }
}

// ============================================================================
// Commentary Generation
// ============================================================================

async function generateCommentary(manual = false) {
    if (!isProviderConfigured()) {
        showError(`${activeProvider().label} is not configured — check the settings`);
        return;
    }

    // Don't spend API calls when there are no other riders to talk about.
    if (!nearbyData.some(r => !r.watching)) {
        if (manual) showError('No nearby riders to comment on yet.');
        return;
    }

    if (isStreaming) return;
    // Don't talk over the previous line — a response can finish streaming while
    // the speech queue is still seconds deep.
    if (!manual && isSpeaking()) return;

    isStreaming = true;
    streamStartedAt = Date.now();
    recentCallTimes.push(streamStartedAt);
    // Barge-in: a new call cuts off the old one rather than queueing behind it.
    cancelSpeech();

    const container = document.getElementById('current-commentary');
    const textEl = container?.querySelector('.commentary-text');

    if (container) {
        container.classList.add('streaming');
        container.classList.remove('error');
    }

    // Keep the previous line on screen and dim it, instead of blanking the
    // overlay for the whole of time-to-first-token.
    const prevHTML = textEl ? textEl.innerHTML : null;
    if (textEl) {
        textEl.classList.add('awaiting');
    }

    try {
        // Build the prompt with rider data
        const { systemPrompt, userPrompt } = buildPrompts();

        // Call Claude API with streaming
        const response = await callClaudeAPI(systemPrompt, userPrompt);

        // Drop a line that just restates the last few — cheaper and less
        // annoying than letting the announcer repeat itself.
        if (isRepetitive(response, conversationHistory)) {
            console.info('[Lunatic] discarded repetitive line:', response);
            if (textEl) textEl.innerHTML = prevHTML ?? '';
            return;
        }

        // The events that motivated this line have now been spoken for.
        pendingEvents = [];

        saveToHistory(response);
        displayCommentary(response);
        updateConversationHistory(userPrompt, response);

        // Clear any prior error state on the status indicator.
        updateApiStatus();

    } catch (err) {
        const stalled = err?.name === 'AbortError';
        console.error('Commentary generation failed:', err);
        showError(stalled ? 'Connection stalled — will retry' : (err.message || 'Failed to generate commentary'));
        // A network stall is transient; don't leave a sticky red error state.
        if (!stalled) {
            markApiError(err);
            if (container) container.classList.add('error');
            if (textEl) {
                textEl.innerHTML = '';
                const p = document.createElement('p');
                p.className = 'placeholder-text';
                p.textContent = `Error: ${err.message || 'Failed to generate commentary'}`;
                textEl.appendChild(p);
            }
        } else if (textEl) {
            textEl.innerHTML = prevHTML ?? '';
        }
    } finally {
        isStreaming = false;
        lastGenerationEnd = Date.now();
        if (container) container.classList.remove('streaming');
        if (textEl) textEl.classList.remove('awaiting');
    }
}

/**
 * Reject a line that shares a 4-word shingle with a recent one, or opens with
 * the same three words. No retry — the next line is seconds away and a retry
 * doubles latency and cost for a line nobody is waiting on.
 */
function isRepetitive(text, history) {
    if (!text) return true;
    const norm = s => String(s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
    const words = norm(text);
    if (words.length < 4) return false;

    const shingles = new Set();
    for (let i = 0; i <= words.length - 4; i++) shingles.add(words.slice(i, i + 4).join(' '));
    const opening = words.slice(0, 3).join(' ');

    for (const h of history.slice(-3)) {
        const hw = norm(h.commentary);
        if (hw.slice(0, 3).join(' ') === opening) return true;
        for (let i = 0; i <= hw.length - 4; i++) {
            if (shingles.has(hw.slice(i, i + 4).join(' '))) return true;
        }
    }
    return false;
}

/**
 * Spoken gap phrasing. In Sauce a NEGATIVE gap means the rider is AHEAD of the
 * camera (stats.mjs sign-flips when rp.reversed, which is exactly the 'ahead'
 * branch). Never emit a bare signed number — the model has no way to know the
 * convention and will guess wrong half the time.
 */
function formatGap(gap) {
    if (gap == null || !isFinite(gap)) return null;
    if (Math.abs(gap) < 0.5) return 'level with you';
    return gap < 0
        ? `${Math.abs(gap).toFixed(0)}s up the road`
        : `${gap.toFixed(0)}s adrift`;
}

/**
 * One-line race header. Every clause is independently omitted when its value is
 * missing or out of range; the whole line is skipped when nothing survives.
 */
function buildRaceContext() {
    const w = watchingAthlete;
    if (!w) return '';
    const bits = [];

    if (raceContextNames.event) bits.push(raceContextNames.event);
    if (raceContextNames.route) bits.push(`on ${raceContextNames.route}`);
    if (raceContextNames.laps) bits.push(`${raceContextNames.laps} laps`);

    // Remaining. remaining > remainingEnd means the event hasn't started;
    // remaining <= 0 means it's over.
    const { remaining, remainingMetric, remainingEnd, remainingType } = w;
    const remOk = typeof remaining === 'number' && isFinite(remaining) && remaining > 0 &&
        (typeof remainingEnd !== 'number' || remaining <= remainingEnd);
    if (remOk) {
        const tail = remainingType === 'route' ? 'left on route' : 'to go';
        bits.push(remainingMetric === 'time'
            ? `${Math.round(remaining / 60)} min ${tail}`
            : `${(remaining / 1000).toFixed(1)} km ${tail}`);
    }

    if (w.eventPosition != null && w.eventParticipants != null) {
        bits.push(`you are ${w.eventPosition} of ${w.eventParticipants}`);
    }

    // state.grade is a ratio, not a percent.
    const grade = w.state?.grade;
    if (typeof grade === 'number' && Math.abs(grade) > 0.02) {
        bits.push(grade > 0
            ? `climbing at ${Math.round(grade * 100)} percent`
            : `descending at ${Math.abs(Math.round(grade * 100))} percent`);
    }

    const pack = buildPackText();
    if (pack) bits.push(pack);

    return bits.length ? `RACE: ${bits.join(' | ')}` : '';
}

/**
 * Pack shape from the 'groups' feed. Deliberately conservative: only group
 * membership and sizes, which are structurally reliable. Returns '' if the
 * feed is unavailable or the watcher isn't locatable in it.
 */
function buildPackText() {
    if (!Array.isArray(groupsData) || groupsData.length < 2) return '';
    const idx = groupsData.findIndex(g => Array.isArray(g?.athletes) && g.athletes.some(a => a?.watching));
    if (idx === -1) return '';

    const size = groupsData[idx].athletes.length;
    const bits = [`you are in a group of ${size}`];
    const ahead = groupsData[idx - 1];
    const behind = groupsData[idx + 1];
    if (Array.isArray(ahead?.athletes) && ahead.athletes.length) {
        bits.push(`a group of ${ahead.athletes.length} up the road`);
    }
    if (Array.isArray(behind?.athletes) && behind.athletes.length) {
        bits.push(`a group of ${behind.athletes.length} chasing`);
    }
    return bits.join(', ');
}

function buildPrompts() {
    const active = library.resolvePrompt(common.settingsStore);
    const isOwn = active.kind === 'user';
    let { systemPrompt, userPromptTemplate } = active;

    const ridersText = buildRidersText();
    const watchingText = buildWatchingText();
    const raceText = buildRaceContext();
    const eventsText = buildEventsText();
    const storyText = buildStorylinesText();

    // "What I already said" sits next to "what is happening now", in the user
    // turn — not the system prompt, which stays a pure function of the preset.
    const recentText = conversationHistory.length
        ? 'RECENTLY SAID — do not repeat these lines, and do not restate their content unless it has changed:\n' +
          conversationHistory.slice(-3).map(h => `- ${h.commentary}`).join('\n')
        : '';

    // split/join so rider names containing '$' sequences aren't treated as
    // replacement patterns, and so every occurrence is replaced.
    let userPrompt = userPromptTemplate
        .split('{riders}').join(ridersText)
        .split('{watchingSection}').join(watchingText)
        .split('{watching}').join(watchingText)
        .split('{raceContext}').join(raceText)
        .split('{events}').join(eventsText)
        .split('{recentLines}').join(recentText);

    // Custom/legacy templates won't carry the new placeholders — prepend or
    // append rather than silently dropping the data.
    if (!userPromptTemplate.includes('{raceContext}') && raceText) {
        userPrompt = `${raceText}\n\n${userPrompt}`;
    }
    if (!userPromptTemplate.includes('{events}') && eventsText) {
        userPrompt = `${eventsText}\n\n${userPrompt}`;
    }
    if (!userPromptTemplate.includes('{recentLines}') && recentText) {
        userPrompt = `${userPrompt}\n\n${recentText}`;
    }
    if (storyText) {
        userPrompt = `${storyText}\n\n${userPrompt}`;
    }

    // Length guard for a prompt the rider wrote, which may carry no length rule
    // of its own; a sentence count is obeyed better than a word count. Built-ins
    // all state the rule themselves (rule 2), and the service does NOT append
    // this — adding it here too would give hosted and BYOK riders different
    // system prompts for the same voice, which is the divergence this file just
    // stopped having.
    if (isOwn) {
        systemPrompt += '\n\nAnswer in one sentence. Two at most.';
    }

    // Collapse blank runs left behind by empty substitutions.
    userPrompt = userPrompt.replace(/\n{3,}/g, '\n\n').trim();

    return { systemPrompt, userPrompt };
}

/** Effective max HR: prefer our own stored value, fall back to the Zwift profile.
 *  NOT stats.hr.max — that is the session-observed max, which starts at 0 and
 *  ratchets up, so it passes during warmup and never means "near their ceiling". */
function effectiveMaxHR(rider) {
    return storedAthleteData[rider.athleteId]?.maxHR || rider.athlete?.maxHeartRate || 0;
}

/** One rider's line. Shared by the field rows and the inline YOU row. */
/** 'smooth5' | 'instant' | 'off' — the one per-rider power setting. */
function powerMode() {
    const m = common.settingsStore.get('powerMode');
    return (m === 'instant' || m === 'off') ? m : 'smooth5';
}

function riderLine(rider, isYou) {
    const parts = [];
    const name = isYou ? '(you)' : (rider.athlete?.sanitizedFullname || rider.athlete?.fLast || 'Unknown');
    const stored = storedAthleteData[rider.athleteId];

    parts.push(isYou ? '>> (you)' : `- ${name}`);

    if (!isYou && common.settingsStore.get('sendGap')) {
        const g = formatGap(rider.gap);
        if (g) parts.push(g);
    }

    // Live rolling averages, not session-lifetime peaks (peaks only ratchet up,
    // so labelling them "15s"/"1m" tells the model they are recent efforts).
    const p5 = rider.stats?.power?.smooth?.[5];
    const p60 = rider.stats?.power?.smooth?.[60];
    const mode = powerMode();
    if (mode === 'smooth5' && p5 > 0) {
        parts.push(`5s: ${Math.round(p5)}W`);
    } else if (mode === 'instant' && rider.state?.power > 0) {
        parts.push(`${Math.round(rider.state.power)}W`);
    }
    if (common.settingsStore.get('sendPower60s') && p60 > 0) {
        parts.push(`last minute: ${Math.round(p60)}W`);
    }

    // Watts per kilo is the 5-second average divided by a weight, so it goes
    // with that average and not on its own. It used to go out whenever p5
    // existed, gated by neither the power boxes nor "Weight" -- which is what
    // made unticking Weight look like it withheld something.
    const kg = rider.athlete?.weight;
    if (mode === 'smooth5' && p5 > 0 && kg > 0) parts.push(`${(p5 / kg).toFixed(1)}w/kg`);

    // HR is noise at rest and the story when pinned.
    const hr = rider.state?.heartrate;
    if (common.settingsStore.get('sendHeartRate') && hr) {
        const maxHR = effectiveMaxHR(rider);
        if (maxHR > 0) {
            const pct = hr / maxHR;
            if (pct >= 0.92) parts.push(`HR ${hr} — pinned at ${Math.round(pct * 100)} percent`);
        } else {
            parts.push(`HR ${hr}`);
        }
    }

    // "Draft: 47W" is not a sentence anyone says.
    if (common.settingsStore.get('sendDraft') && rider.state?.draft !== undefined) {
        parts.push(rider.state.draft > 0 ? 'sheltered' : 'in the wind');
    }

    if (common.settingsStore.get('sendSpeed') && rider.state?.speed > 0) {
        parts.push(`${rider.state.speed.toFixed(0)}kph`);
    }
    if (common.settingsStore.get('sendCadence') && rider.state?.cadence) {
        parts.push(`${rider.state.cadence}rpm`);
    }

    if (stored) {
        if (common.settingsStore.get('sendFTP') && stored.zpFTP) parts.push(`FTP ${stored.zpFTP}`);
        if (common.settingsStore.get('sendPhenotype') && stored.phenotype_value) parts.push(String(stored.phenotype_value));
        if (common.settingsStore.get('sendRaceRating') && stored.race_current_rating) {
            parts.push(`rating ${stored.race_current_rating.toFixed(0)}`);
        }
        if (common.settingsStore.get('sendWeight') && stored.weight) parts.push(`${stored.weight.toFixed(0)}kg`);
        if (common.settingsStore.get('sendRaceStats')) {
            const wins = stored.race_wins || 0;
            const podiums = stored.race_podiums || 0;
            if (wins > 0 || podiums > 0) parts.push(`${wins} wins, ${podiums} podiums`);
        }
    }

    return parts.join('  ');
}

/**
 * The field, in ROAD ORDER. Sauce already returns `nearby` sorted front-to-back
 * (stats.mjs: nearby.sort((a,b) => a.gap - b.gap)), so we must NOT re-sort by
 * |gap| — that interleaves riders ahead and behind and deletes the road, which
 * is an announcer's entire mental model.
 */
function buildRidersText() {
    const maxRiders = common.settingsStore.get('maxRiders') || 10;
    if (!nearbyData.length) return 'No nearby riders detected.';

    // Window around the watching athlete, biased forward, derived from maxRiders.
    const wIdx = nearbyData.findIndex(r => r.watching);
    const aheadCount = Math.ceil(maxRiders * 0.6);
    const behindCount = maxRiders - aheadCount;
    let start, end;
    if (wIdx === -1) {
        start = 0;
        end = Math.min(nearbyData.length, maxRiders);
    } else {
        start = Math.max(0, wIdx - aheadCount);
        end = Math.min(nearbyData.length, wIdx + behindCount + 1);
    }

    const rows = nearbyData.slice(start, end)
        .filter(r => r.athlete?.type !== 'PACER_BOT')
        .map(r => riderLine(r, !!r.watching));

    return rows.length ? rows.join('\n') : 'No nearby riders detected.';
}

/**
 * Always ''. The watcher is rendered inline in road order by buildRidersText().
 *
 * There used to be an "Include watching athlete's data" checkbox here. Unticking
 * it did not withhold anything: it moved the rider's own line out of road order
 * into a separate YOU block -- the same numbers, arguably with more attention on
 * them -- while race context and the athlete id went out regardless. A label
 * that says "include" and withholds nothing is worse than no label, and no
 * truthful opt-out was reachable through that toggle, so it is gone.
 *
 * The function and the {watchingSection} placeholder stay: every preset embeds
 * them and riders write their own templates against them.
 */
function buildWatchingText() {
    return '';
}

// ============================================================================
// Change detection — the difference between describing a table and calling a race
// ============================================================================

const TRACK_SAMPLES = 30;       // ~30s of history at Sauce's 1Hz tick
const TRACK_STALE_MS = 60000;
const COOLDOWNS = { ATTACK: 45000, CRACKING: 60000, GAP_OPENING: 30000, GAP_CLOSING: 30000, CATCH: 45000, DROPPED: 60000 };
const SCORES = { ATTACK: 10, CATCH: 8, DROPPED: 8, CRACKING: 7, GAP_OPENING: 6, GAP_CLOSING: 6 };
const cooldowns = new Map();

function nameOf(rider) {
    return rider.athlete?.sanitizedFullname || rider.athlete?.fLast || 'A rider';
}

function offCooldown(id, kind, now) {
    const key = `${id}:${kind}`;
    const last = cooldowns.get(key) || 0;
    if (now - last < (COOLDOWNS[kind] || 30000)) return false;
    cooldowns.set(key, now);
    return true;
}

/** Sample every visible rider once per tick. */
function updateTracks(data, now) {
    for (const r of data) {
        if (r.athlete?.type === 'PACER_BOT') continue;
        const id = r.athleteId;
        let t = tracks.get(id);
        if (!t) {
            t = { samples: [], seen: now, ticks: 0 };
            tracks.set(id, t);
        }
        t.seen = now;
        t.ticks++;
        t.samples.push({
            t: now,
            gap: typeof r.gap === 'number' ? r.gap : null,
            p5: r.stats?.power?.smooth?.[5] ?? null,
            p60: r.stats?.power?.smooth?.[60] ?? null,
            hr: r.state?.heartrate ?? null,
        });
        if (t.samples.length > TRACK_SAMPLES) t.samples.shift();
    }
    for (const [id, t] of tracks) {
        if (now - t.seen > TRACK_STALE_MS) tracks.delete(id);
    }
}

/** Value of `field` roughly `ageMs` ago, or null. */
function sampleAgo(track, ageMs, field, now) {
    for (let i = track.samples.length - 1; i >= 0; i--) {
        const s = track.samples[i];
        if (now - s.t >= ageMs) return s[field];
    }
    return null;
}

/**
 * Turn the last few seconds of samples into notable events. Each fires at most
 * once per athlete per kind per cooldown; thresholds are deliberately
 * conservative because a false "attack" every tick is worse than silence.
 */
function detectEvents(data, now) {
    const found = [];
    for (const r of data) {
        const id = r.athleteId;
        const track = tracks.get(id);
        if (!track || track.samples.length < 4 || r.watching) continue;

        const cur = track.samples[track.samples.length - 1];
        const name = nameOf(r);
        const gapNow = cur.gap;
        const gap10 = sampleAgo(track, 10000, 'gap', now);
        const gap20 = sampleAgo(track, 20000, 'gap', now);

        // ATTACK — a big effort relative to that rider's own last minute.
        if (cur.p5 > 0 && cur.p60 > 0 && cur.p5 >= 1.6 * cur.p60 && cur.p5 >= 400) {
            const held = track.samples.slice(-3).every(s => s.p5 > 0 && s.p60 > 0 && s.p5 >= 1.6 * s.p60);
            if (held && offCooldown(id, 'ATTACK', now)) {
                const kg = r.athlete?.weight;
                const wkg = (kg > 0 && powerMode() === 'smooth5')
                    ? `, ${(cur.p5 / kg).toFixed(1)} watts per kilo` : '';
                found.push({ kind: 'ATTACK', id, score: SCORES.ATTACK,
                    text: `ATTACK: ${name} ${Math.round(cur.p5)} watts${wkg}, was ${Math.round(cur.p60)} for the last minute` });
            }
        }

        // CRACKING — effort collapsed and losing ground.
        if (cur.p5 > 0 && cur.p60 >= 200 && cur.p5 <= 0.55 * cur.p60 &&
            gapNow != null && gap20 != null && Math.abs(gapNow) - Math.abs(gap20) >= 3) {
            if (offCooldown(id, 'CRACKING', now)) {
                found.push({ kind: 'CRACKING', id, score: SCORES.CRACKING,
                    text: `CRACKING: ${name} down to ${Math.round(cur.p5)} watts from ${Math.round(cur.p60)}, losing ground` });
            }
        }

        if (gapNow != null && gap10 != null) {
            const delta = Math.abs(gapNow) - Math.abs(gap10);

            // CATCH — came back to within 2s.
            if (Math.abs(gapNow) < 2 && Math.abs(gap10) >= 3 && offCooldown(id, 'CATCH', now)) {
                found.push({ kind: 'CATCH', id, score: SCORES.CATCH,
                    text: `CATCH: ${name} has been brought back` });
            } else if (delta >= 5 && offCooldown(id, 'DROPPED', now)) {
                found.push({ kind: 'DROPPED', id, score: SCORES.DROPPED,
                    text: `DROPPED: ${name} has lost ${delta.toFixed(0)} seconds in ten` });
            } else if (delta >= 3 && offCooldown(id, 'GAP_OPENING', now)) {
                found.push({ kind: 'GAP_OPENING', id, score: SCORES.GAP_OPENING,
                    text: `GAP OPENING: ${name} now ${formatGap(gapNow)}` });
            } else if (delta <= -3 && offCooldown(id, 'GAP_CLOSING', now)) {
                found.push({ kind: 'GAP_CLOSING', id, score: SCORES.GAP_CLOSING,
                    text: `GAP CLOSING: ${name} now ${formatGap(gapNow)}` });
            }
        }
    }

    for (const ev of found) {
        pendingEvents.push({ ...ev, at: now });
        openStoryline(ev, now);
    }
    // Keep the queue small; a 40s-old "gap opening" is a lie by the time it's read.
    pendingEvents = pendingEvents.filter(e => now - e.at < 20000).slice(-12);
    return found;
}

function openStoryline(ev, now) {
    if (['ATTACK', 'DROPPED', 'CRACKING'].includes(ev.kind)) {
        storylines.set(ev.id, { kind: ev.kind, openedAt: now, summary: ev.text });
    } else if (ev.kind === 'CATCH') {
        storylines.delete(ev.id);
    }
    for (const [id, s] of storylines) {
        if (now - s.openedAt > 180000) storylines.delete(id);
    }
}

function buildEventsText() {
    if (!pendingEvents.length) return '';
    const top = [...pendingEvents].sort((a, b) => b.score - a.score).slice(0, 3);
    return 'EVENTS (just now):\n' + top.map(e => `- ${e.text}`).join('\n');
}

function buildStorylinesText() {
    if (!storylines.size) return '';
    const now = Date.now();
    const lines = [...storylines.entries()].slice(0, 4).map(([, s]) => {
        const secs = Math.round((now - s.openedAt) / 1000);
        const mmss = secs >= 60 ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : `${secs}s`;
        return `- ${s.summary} (${mmss} ago)`;
    });
    return 'STORYLINES IN PLAY — refer back to these when the new events touch them:\n' + lines.join('\n');
}

/** Event-driven cadence: fire on what happened, not on a wall clock. */
function shouldFireNow(now) {
    if (isPaused || isStreaming) return false;
    if (!isProviderConfigured()) return false;
    if (!nearbyData.some(r => !r.watching)) return false;
    if (!common.settingsStore.get('eventDriven')) return false;

    const minInterval = (parseInt(common.settingsStore.get('minInterval') ?? 12, 10) || 12) * 1000;
    const sinceLast = now - lastGenerationEnd;
    if (sinceLast < minInterval) return false;

    // Hard cap on spend: 8 calls per rolling 60s.
    recentCallTimes = recentCallTimes.filter(t => now - t < 60000);
    if (recentCallTimes.length >= 8) return false;

    const best = pendingEvents.reduce((m, e) => Math.max(m, e.score), 0);
    if (best >= 10) return true;
    if (best >= 6 && sinceLast > 25000) return true;

    // Longest-silence floor (the existing updateInterval setting).
    const maxSilence = clockSeconds() * 1000;
    return maxSilence > 0 && sinceLast > maxSilence;
}

// ============================================================================
// Text to speech — the announcer is something you HEAR
// ============================================================================

const NOVELTY_VOICES = new Set(['Bad News', 'Bahh', 'Bells', 'Boing', 'Bubbles', 'Cellos',
    'Good News', 'Jester', 'Organ', 'Superstar', 'Trinoids', 'Whisper', 'Wobble', 'Zarvox', 'Albert']);

/**
 * The voices worth offering, English first.
 *
 * English only was a silent kill switch on any machine whose OS language is not
 * English: the filter emptied the list, pickVoice() returned null and speech
 * simply never happened, with nothing on screen to say why. English is still
 * preferred -- the prompts write numbers out as English words -- but when there
 * is none, offer what the machine has rather than nothing.
 */
function listVoices() {
    if (typeof speechSynthesis === 'undefined') return [];
    const all = speechSynthesis.getVoices().filter(v => !NOVELTY_VOICES.has(v.name));
    const english = all.filter(v => /^en/i.test(v.lang));
    return english.length ? english : all;
}

/**
 * Apple's names first because they are the best of the built-ins, then
 * Microsoft's so a Windows machine lands somewhere deliberate rather than on
 * whatever getVoices() happens to return first. Unverified on Windows: nothing
 * in this repo has run there, so every name below is a preference that falls
 * through harmlessly when absent.
 */
const PREFERRED_VOICES = ['Daniel', 'Samantha', 'Microsoft David', 'Microsoft Zira', 'Microsoft Mark'];

function pickVoice() {
    const voices = listVoices();
    if (!voices.length) return null;
    const want = common.settingsStore.get('ttsVoice');
    const stored = voices.find(v => v.name === want);
    if (stored) return stored;
    for (const name of PREFERRED_VOICES) {
        const hit = voices.find(v => v.name === name || v.name.startsWith(`${name} `));
        if (hit) return hit;
    }
    return voices[0];
}

function initTTS() {
    if (typeof speechSynthesis === 'undefined') return;
    const load = () => { ttsVoice = pickVoice(); };
    load();
    speechSynthesis.addEventListener('voiceschanged', load);
    setTimeout(load, 3000);
    window.addEventListener('pagehide', () => speechSynthesis.cancel());
}

/** Cold start is ~800ms, warm ~2ms — pay it once up front, silently. */
function warmTTS() {
    if (ttsWarmed || typeof speechSynthesis === 'undefined') return;
    ttsWarmed = true;
    try {
        const u = new SpeechSynthesisUtterance('go');
        u.volume = 0;
        u.rate = 2;
        speechSynthesis.speak(u);
    } catch (e) { /* non-fatal */ }
}

function cancelSpeech() {
    if (typeof speechSynthesis === 'undefined') return;
    try { speechSynthesis.cancel(); } catch (e) { /* non-fatal */ }
}

function isSpeaking() {
    return typeof speechSynthesis !== 'undefined' && (speechSynthesis.speaking || speechSynthesis.pending);
}

/**
 * Say one line. Returns the utterance so a caller can watch it, or null when
 * nothing was said.
 *
 * `force` is for Test Voice, which must speak whether or not the rider has the
 * setting on. It used to get there by writing ttsEnabled true, speaking, and
 * writing it back false -- two store writes that woke both windows' listeners
 * and flickered the overlay's mute button every time anyone pressed Test.
 */
function speak(text, { force = false } = {}) {
    if (!force && !common.settingsStore.get('ttsEnabled')) return null;
    if (typeof speechSynthesis === 'undefined') return null;
    const clean = String(text).trim();
    if (!clean) return null;
    try {
        const u = new SpeechSynthesisUtterance(clean);
        if (ttsVoice) u.voice = ttsVoice;
        u.rate = Number(common.settingsStore.get('ttsRate')) || 1.2;
        u.pitch = Number(common.settingsStore.get('ttsPitch')) || 1.1;
        u.volume = Number(common.settingsStore.get('ttsVolume') ?? 1);
        // 'interrupted'/'canceled' are the normal result of barge-in, not errors.
        u.onerror = ev => {
            if (ev.error !== 'interrupted' && ev.error !== 'canceled') {
                console.warn('[Lunatic] speech error:', ev.error);
            }
        };
        speechSynthesis.speak(u);
        return u;
    } catch (e) {
        console.warn('[Lunatic] speech failed:', e);
        return null;
    }
}

/**
 * Speak complete sentences as they stream in, so audio starts at the first
 * full sentence instead of after the whole response. Requires whitespace/EOS
 * after the terminator and refuses to split on a digit ("4.2 w/kg").
 */
function flushSpokenSentences(full, spokenUpTo) {
    const pending = full.slice(spokenUpTo);
    const re = /(?<!\d)[.!?](?=\s|$)/g;
    let m, last = 0;
    while ((m = re.exec(pending)) !== null) {
        const end = m.index + 1;
        const sentence = pending.slice(last, end).trim();
        if (sentence) speak(sentence);
        last = end;
    }
    return spokenUpTo + last;
}

async function callClaudeAPI(systemPrompt, userPrompt) {
    const providerId = activeProviderId();
    const model = activeModel();
    const maxTokens = common.settingsStore.get('maxTokens') || 60;
    const textEl = document.querySelector('#current-commentary .commentary-text');

    // Reset per ATTEMPT, not per call: streamCompletion retries once on a
    // transient failure, and a retry must rebuild the text node and re-speak
    // from the start rather than append to a half-written line.
    let node = null;
    let spokenUpTo = 0;

    const result = await streamCompletion({
        provider: providerId,
        model,
        apiKey: activeApiKey(),
        baseUrl: activeBaseUrl(),
        preset: activePresetId(),
        systemPrompt,
        userPrompt,
        maxTokens,

        // Only the hosted adapter reads these; the others ignore the object.
        extra: {
            // One voice setting for every provider. The service only knows
            // built-ins -- and discards a client system prompt on the free tier
            // anyway -- so a rider running their own version of Lunatic hears
            // Lunatic there rather than the default.
            style: library.hostedStyleFor(common.settingsStore),
            athleteId: watchingAthlete?.athleteId ?? null
        },

        onResponse: response => {
            // The hosted tier bills in calls, not dollars, so the overlay shows
            // the allowance the service reports rather than a price.
            const left = response.headers.get('X-Lunatic-Quota-Remaining');
            if (left !== null && left !== '') {
                common.settingsStore.set(QUOTA_KEY, Number(left));
            }
        },

        onController: ctrl => {
            activeAbort = ctrl;
            node = null;
            spokenUpTo = 0;
        },
        onSettled: ctrl => {
            if (activeAbort === ctrl) activeAbort = null;
        },

        onText: (chunk, full) => {
            if (textEl) {
                // Lazily swap to a text node on the FIRST delta, so the previous
                // line stays up through TTFT. Text nodes cannot inject markup,
                // so no escaping is needed here; displayCommentary() does the
                // single final parse.
                if (!node) {
                    textEl.classList.remove('awaiting');
                    textEl.textContent = '';
                    node = document.createTextNode('');
                    const cursor = document.createElement('span');
                    cursor.className = 'streaming-cursor';
                    textEl.append(node, cursor);
                }
                node.appendData(chunk);
            }
            // Start speaking at the first complete sentence rather than waiting
            // for the whole response.
            spokenUpTo = flushSpokenSentences(full, spokenUpTo);
        }
    });

    // Speak any trailing fragment with no terminal punctuation.
    const tail = result.text.slice(spokenUpTo).trim();
    if (tail) speak(tail);

    updateCost(providerId, model, result.inputTokens, result.outputTokens);
    return result.text;
}

/** True when the active model has a price we can actually apply. */
function currentCostIsTracked() {
    const prov = activeProvider();
    if (prov.models?.[activeModel()]) return true;
    return Number(common.settingsStore.get('compatInputCost')) > 0 ||
           Number(common.settingsStore.get('compatOutputCost')) > 0;
}

function updateCost(providerId, model, inputTokens, outputTokens) {
    const { cost, known } = costFor({
        providerId,
        model,
        inputTokens,
        outputTokens,
        userInputPer1M: common.settingsStore.get('compatInputCost'),
        userOutputPer1M: common.settingsStore.get('compatOutputCost')
    });

    // An unpriced model contributes calls but not dollars. Quoting a local
    // Ollama run at Haiku rates would be worse than admitting we don't know.
    if (known) sessionCost += cost;
    totalCalls++;

    // Persist to shared (global) keys so the settings window sees the same
    // numbers and its reset button can clear them across windows.
    common.settingsStore.set(COST_KEY, sessionCost);
    common.settingsStore.set(CALLS_KEY, totalCalls);
    renderCost();
}

// Render the shared cost/call counters into whichever elements exist in the
// current window (main window: #session-cost; settings window: #session-cost-display
// and #total-calls-display).
function renderCost() {
    const calls = common.settingsStore.get(CALLS_KEY) || 0;
    const el = document.getElementById('session-cost');

    // The overlay shows a bare "$" and puts the figure in the tooltip: the
    // number matters when you go looking for it, not while you are racing.
    // The settings window has room, so it still shows the value inline.
    const inline = document.getElementById('session-cost-display');
    const callsEl = document.getElementById('total-calls-display');
    if (callsEl) callsEl.textContent = String(calls);

    if (activeProviderId() === 'hosted') {
        const left = common.settingsStore.get(QUOTA_KEY);
        const label = (left === null || left === undefined) ? '—' : `${left} left`;
        const detail = (left === null || left === undefined)
            ? 'Free calls remaining: unknown until the next call'
            : `${left} free calls left this month · ${calls} calls this session`;
        if (el) { el.textContent = '$'; el.title = detail; el.classList.add('free'); }
        if (inline) { inline.textContent = label; inline.title = detail; }
        return;
    }

    const cost = common.settingsStore.get(COST_KEY) || 0;
    const tracked = currentCostIsTracked();
    const money = `$${cost < 1 ? cost.toFixed(4) : cost.toFixed(2)}${tracked ? '' : '*'}`;
    const detail = tracked
        ? `${money} this session · ${calls} calls`
        : `${money} this session · ${calls} calls — the asterisk means at least this much: ` +
          'the selected model has no known price. Enter one in settings to track it.';

    if (el) { el.textContent = '$'; el.title = detail; el.classList.remove('free'); }
    if (inline) { inline.textContent = money; inline.title = tracked ? '' : detail; }
}

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatCommentary(text) {
    // Escape first (model output can echo attacker-controlled rider names),
    // then convert blank lines to paragraphs and single newlines to <br>.
    return text.split('\n\n')
        .filter(p => p.trim())
        .map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
        .join('');
}

function displayCommentary(text) {
    const container = document.getElementById('current-commentary');
    const textEl = container?.querySelector('.commentary-text');
    if (!textEl) return;

    textEl.innerHTML = formatCommentary(text);

    // Keep the timestamp a sibling of .commentary-text so copy-to-clipboard
    // (which reads .commentary-text) doesn't pick it up, and so timestamps
    // don't accumulate.
    let ts = container.querySelector(':scope > .commentary-timestamp');
    if (!ts) {
        ts = document.createElement('div');
        ts.className = 'commentary-timestamp';
        container.appendChild(ts);
    }
    ts.textContent = new Date().toLocaleTimeString();
}

function saveToHistory(commentary) {
    const historyCount = common.settingsStore.get('historyCount') ?? 3;

    commentaryHistory.unshift({
        text: commentary,
        timestamp: new Date()
    });

    // +1: entry 0 is the line on screen above, not history. "How many to show:
    // 3" kept three entries in all and rendered slice(1), so a rider who asked
    // for three previous lines got two.
    commentaryHistory = commentaryHistory.slice(0, historyCount + 1);

    // Update history display
    renderHistory();
}

function renderHistory() {
    const container = document.getElementById('history-container');
    const entriesEl = document.getElementById('history-entries');

    if (!container || !entriesEl) return;

    // Off by setting, or nothing to show yet. Entry 0 is the line already
    // displayed above, so two entries are needed before there is any history.
    if (!common.settingsStore.get('showHistory') || commentaryHistory.length <= 1) {
        container.hidden = true;
        return;
    }

    container.hidden = false;

    // Skip the first entry (it's the current one)
    entriesEl.innerHTML = commentaryHistory.slice(1).map(entry => `
        <div class="history-entry">
            <div class="commentary-text">${formatCommentary(entry.text)}</div>
            <div class="commentary-timestamp">${entry.timestamp.toLocaleTimeString()}</div>
        </div>
    `).join('');
}

function updateConversationHistory(userPrompt, response) {
    conversationHistory.push({
        timestamp: new Date(),
        commentary: response.substring(0, 200) // Keep just a summary for context
    });

    // Keep last 5 for context
    if (conversationHistory.length > 5) {
        conversationHistory.shift();
    }
}

// ============================================================================
// Settings Window Functions
// ============================================================================

/**
 * Main entry point for Live Commentary Settings window
 */
export async function lunaticAnnouncerSettingsMain() {
    common.initInteractionListeners();

    // Setup tabs
    setupTabs();

    // Both migrations run BEFORE anything reads the active voice: the model one
    // maps legacy voice ids onto canonical ones, and this moves the old single
    // custom slot into the library so the picker has it to show.
    library.migratePrompts(common.settingsStore);
    // Drop any retired/unknown stored model BEFORE the form binds, so the
    // dropdown loads a value that actually matches one of its options.
    migrateModelSetting();
    // Before setupDataFields() reads powerMode into the select.
    migrateDataFields();

    // Initialize settings form — the returned callback MUST be invoked (the
    // trailing ()) or fields never load and every edit throws before saving.
    await common.initSettingsForm('#display-options')();
    await common.initSettingsForm('#update-options')();
    await common.initSettingsForm('#api-options')();
    // Voice list must exist before the form binds, or the stored voice won't match.
    initTTS();
    // NOT awaited. It waits up to 3s for `voiceschanged`, and awaiting it here
    // left every control in the window unwired for that whole time on a machine
    // with no voices ready -- the tab strip, the provider fields, all of it.
    populateVoicePicker();
    await common.initSettingsForm('#audio-options')();
    setupVoiceTest();

    // The Data Fields tab reports whether the GOTTA.BIKE import has anything
    // in it, so this window needs the data too -- only the overlay loaded it.
    loadStoredAthleteData();

    // Setup custom controls
    setupApiKeyToggle();
    setupProviderControls();
    setupHostedControls();
    setupTestConnection();
    setupPromptLibrary();
    setupDataFields();
    setupCostReset();

    // Load current API info
    updateApiInfo();

    renderHelpLink();
    renderHelpVoices();

    // Render shared cost counters and keep them live across windows.
    renderCost();
    common.settingsStore.addEventListener('set', ev => {
        if (ev.data.key === COST_KEY || ev.data.key === CALLS_KEY) renderCost();
        // GOTTA.BIKE Sauce importing while this window is open.
        if (ev.data.key === ATHLETE_DATA_KEY) {
            storedAthleteData = ev.data.value || {};
            renderStoredDataStatus();
        }
    });

    // Listen for settings changes
    common.settingsStore.addEventListener('changed', ev => {
        const changed = ev.data.changed;
        if (changed.has('stylePreset') || changed.has(library.LIBRARY_KEY) ||
            changed.has(library.CACHE_KEY)) {
            renderPromptPicker();
            renderPromptEditor();
            renderPromptNotice();
            renderHelpVoices();     // the cache is where a new voice arrives
        }
        // Any provider setting moving means the Status box may be wrong: a
        // "Connected" earned by a test no longer describes the new model or
        // key. The form-bound controls (the Claude Model select, the compat
        // fields) write the store directly and never called this before, so
        // a rider could swap models after a passing test and keep the green.
        if (PROVIDER_SETTING_KEYS.some(k => changed.has(k))) {
            updateApiInfo();
            renderPromptProviderNote();
            renderHelpLink();
        }
        // The next-step row says whether it will speak. renderApiInfo(), not
        // updateApiInfo(): repainting must not downgrade a box that a passing
        // test earned, and muting says nothing about the provider settings.
        if (changed.has('ttsEnabled')) renderApiInfo();
    });

    // Initial visibility
    updateCustomColorVisibility();
}

/** Show one tab. Exported to the rest of the file, not just the tab strip. */
function activateTab(tabId) {
    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabPanels = document.querySelectorAll('.tab-panel');
    if (![...tabBtns].some(b => b.dataset.tab === tabId)) return false;
    tabBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === tabId));
    tabPanels.forEach(p => p.classList.toggle('active', p.id === tabId));
    return true;
}

function setupTabs() {
    for (const btn of document.querySelectorAll('.tab-btn')) {
        btn.addEventListener('click', () => {
            activateTab(btn.dataset.tab);
            // Remembered per window, so a rider heading to Prompts every
            // session is not routed through Display Options first.
            common.settingsStore.set('settingsTab', btn.dataset.tab);
        });
    }
    // Anything in the page can send a rider to a tab: the Settings-tab nudge.
    for (const link of document.querySelectorAll('[data-goto-tab]')) {
        link.addEventListener('click', ev => {
            ev.preventDefault();
            activateTab(link.dataset.gotoTab);
        });
    }

    // Where to open. The overlay's only instruction is "pick an AI provider",
    // and the gear used to land on Font scaling with nothing pointing one tab
    // over. Unconfigured -> the provider tab; otherwise where they last were.
    const remembered = common.settingsStore.get('settingsTab');
    activateTab(!isProviderConfigured() ? 'api-tab' : (remembered || 'settings-tab'));
}

/** Show/hide toggle plus trim-on-save for one API key field. */
function setupKeyField(toggleId, inputId, settingKey) {
    const toggleBtn = document.getElementById(toggleId);
    const keyInput = document.getElementById(inputId);
    if (!keyInput) return;

    if (toggleBtn) {
        toggleBtn.addEventListener('click', () => {
            const isPassword = keyInput.type === 'password';
            keyInput.type = isPassword ? 'text' : 'password';

            const icon = toggleBtn.querySelector('ms');
            if (icon) {
                icon.textContent = isPassword ? 'visibility_off' : 'visibility';
            }
        });
    }

    keyInput.value = common.settingsStore.get(settingKey) || '';

    keyInput.addEventListener('change', () => {
        common.settingsStore.set(settingKey, keyInput.value.trim());
        updateApiInfo();
    });
}

function setupApiKeyToggle() {
    setupKeyField('toggle-key-visibility', 'claude-api-key', 'claudeApiKey');
    setupKeyField('toggle-compat-key-visibility', 'compat-api-key', 'compatApiKey');
}

/**
 * The same bound the streaming shell puts on time-to-first-token
 * (providers.mjs, `bump(15000)`). A test with no bound at all was the one
 * request in the mod that could hang indefinitely -- and it is the control
 * whose entire job is diagnosis.
 */
const TEST_TIMEOUT_MS = 15000;

async function setupTestConnection() {
    const testBtn = document.getElementById('test-api-btn');
    const statusEl = document.getElementById('api-test-status');

    if (!testBtn) return;

    // Non-null while a test is in flight. The button becomes Cancel rather
    // than going disabled: against a host that never answers, a disabled
    // button means a rider who spots their typo cannot re-test without
    // closing the window.
    let inFlight = null;

    const setIdle = () => {
        inFlight = null;
        testBtn.textContent = 'Test Connection';
        testBtn.classList.remove('testing');
    };

    testBtn.addEventListener('click', async () => {
        if (inFlight) {
            inFlight.abort();
            return;                      // the handler below reports the outcome
        }
        if (!isProviderConfigured()) {
            // Say what to do, not what is missing in the abstract.
            statusEl.textContent = {
                anthropic: 'Paste your Anthropic API key first.',
                compatible: 'Enter a model id (and your key, if the service needs one) first.',
                hosted: 'Press Connect first.'
            }[activeProviderId()] || `${activeProvider().label} is not configured`;
            statusEl.className = 'error';
            return;
        }

        const prov = activeProvider();
        const ctrl = new AbortController();
        inFlight = ctrl;
        // A host that accepts the connection and then says nothing is the case
        // the browser's own timeout takes minutes to fail.
        const timer = setTimeout(() => ctrl.abort(new DOMException('timed out', 'TimeoutError')),
            TEST_TIMEOUT_MS);
        testBtn.textContent = 'Cancel';
        testBtn.classList.add('testing');
        statusEl.textContent = 'Testing…';
        statusEl.className = 'loading';

        let reqUrl = '';
        try {
            // Built through the adapter, not hand-rolled: a second copy of the
            // request shape drifts, and then the test passes for a model the
            // overlay cannot actually use.
            const req = prov.buildRequest({
                model: activeModel(),
                apiKey: activeApiKey(),
                baseUrl: activeBaseUrl(),
                preset: activePresetId(),
                systemPrompt: 'Reply with OK.',
                userPrompt: 'Say "OK"',
                maxTokens: 16
            });

            reqUrl = req.url;
            const response = await fetch(req.url, {
                method: 'POST',
                headers: req.headers,
                // Non-streaming for the test: we only care that the request is
                // accepted, and a stream would need the whole reader loop.
                body: JSON.stringify({ ...req.body, stream: false, stream_options: undefined }),
                signal: ctrl.signal
            });

            if (response.ok) {
                statusEl.textContent = 'Connection successful!';
                statusEl.className = 'success';
                updateApiInfo(true);
            } else {
                const body = await response.json().catch(() => ({}));
                const info = prov.parseHttpError(response.status, body, response.headers);
                statusEl.textContent = info.message;
                statusEl.className = 'error';
                markApiTestFailed();
            }
        } catch (err) {
            statusEl.textContent = describeTestFailure(err, reqUrl);
            statusEl.className = 'error';
            // A test the rider cancelled says nothing about the settings, so
            // it must not paint the Status box red.
            if (err?.name !== 'AbortError') markApiTestFailed();
        } finally {
            clearTimeout(timer);
            setIdle();
            // The rider clicked this button; leave the focus where they put it
            // rather than dropping it on <body>.
            testBtn.focus();
        }
    });
}

/**
 * Turn a failed test into something a rider can act on.
 *
 * `fetch` rejects with a bare "Failed to fetch" for every network-layer
 * problem there is -- wrong port, host asleep, VPN swallowing it, CORS -- so
 * the host is the one piece of information worth adding.
 */
function describeTestFailure(err, url) {
    let host = '';
    try { host = new URL(url).host; } catch { /* the URL never got built */ }
    const where = host || 'the service';

    if (err?.name === 'TimeoutError') {
        return `No reply from ${where} after ${TEST_TIMEOUT_MS / 1000} seconds — check the URL. ` +
            'Running a local server? Make sure it is started.';
    }
    if (err?.name === 'AbortError') return 'Test cancelled.';
    if (err instanceof TypeError) {
        return `Could not reach ${where} — check the URL and your connection.`;
    }
    return `Error: ${err?.message || 'unknown error'}`;
}

/**
 * What the last Test Connection / Connect actually said. `updateApiInfo()` reads
 * it so a green box means "a request succeeded", never merely "a field has
 * text in it" -- which is what it used to mean, and why a mistyped key looked
 * like success and Test Connection looked optional.
 *   'none'   nothing tested since the settings last changed
 *   'ok'     the last test or connect succeeded
 *   'failed' the last test failed
 */
let apiTestOutcome = 'none';

/**
 * The Status box on the AI Provider tab. Always visible; tinted by state.
 *
 * @param {boolean} connected  a request just succeeded (Test Connection, Connect,
 *   sign-in, the hosted on-open refresh). Anything else is a settings change,
 *   which downgrades a previous success to "changed since the last test".
 */
function updateApiInfo(connected = false) {
    if (connected) {
        apiTestOutcome = 'ok';
    } else if (apiTestOutcome === 'ok' || apiTestOutcome === 'failed') {
        // A result that is no longer known to hold, either way: the rider
        // changed something since. Clear the inline "Connection successful!"
        // / error line too, or it sits beside the downgrade contradicting it.
        apiTestOutcome = 'stale';
        const testStatus = document.getElementById('api-test-status');
        if (testStatus) { testStatus.textContent = ''; testStatus.className = ''; }
    }
    renderApiInfo();
}

/** Record a failed Test Connection so the Status box turns red, not stays green. */
function markApiTestFailed() {
    apiTestOutcome = 'failed';
    renderApiInfo();
}

/** Paint the Status box from `apiTestOutcome` and the current settings. No transitions. */
function renderApiInfo() {
    const configured = isProviderConfigured();
    const infoEl = document.getElementById('api-info');
    const statusText = document.getElementById('api-status-text');
    const modelText = document.getElementById('api-model-text');
    const nextStep = document.getElementById('api-next-step');
    const noKeyHint = document.getElementById('no-key-hint');
    const nudge = document.getElementById('setup-nudge');

    if (!configured) apiTestOutcome = 'none';

    const providerId = activeProviderId();
    let state, text;
    if (!configured) {
        state = 'unconfigured';
        text = 'Not configured — pick Lunatic hosted for free commentary, or paste an API key.';
    } else if (apiTestOutcome === 'ok') {
        state = 'connected';
        text = 'Connected';
    } else if (apiTestOutcome === 'failed') {
        state = 'failed';
        text = 'Test failed — check your key and model';
    } else if (apiTestOutcome === 'stale') {
        state = 'stale';
        text = 'Configured — settings changed since the last test';
    } else {
        state = 'untested';
        text = providerId === 'hosted' ? 'Saved — not checked yet' : 'Key saved — not tested';
    }

    if (infoEl) {
        infoEl.hidden = false;
        infoEl.className = `api-info ${state}`;
    }
    if (statusText) {
        statusText.textContent = text;
        statusText.classList.toggle('connected', state === 'connected');
    }
    if (modelText) {
        modelText.textContent = configured
            ? `${activeProvider().label} · ${activeModel() || '(no model set)'}`
            : '—';
    }
    // The one thing a first-run rider needs to be told, at the moment it is true.
    if (nextStep) {
        nextStep.hidden = state !== 'connected';
        if (state === 'connected') {
            // Speech is ON by default, so the thing to say first is that it
            // will start talking and how to stop it -- not that it is silent.
            const tts = common.settingsStore.get('ttsEnabled');
            nextStep.textContent = 'Close this window and ride — commentary fires when riders are ' +
                'around you. ' + (tts
                    ? 'It speaks aloud; the speaker button in the announcer window mutes it.'
                    : 'Speech is off; turn it on under Settings › Announcer Audio.');
        }
    }
    // A rider with no key, looking at a provider that needs one.
    if (noKeyHint) noKeyHint.hidden = configured || providerId === 'hosted';
    if (nudge) nudge.hidden = configured;
}

/**
 * One place that decides what the connection row says and which buttons are
 * offered. Three states, and the difference between them matters: an anonymous
 * token is lost when settings are cleared, a Discord one is not.
 *
 * Module scope on purpose. Both halves of the settings page need it -- the
 * provider picker, which reveals the row, and the hosted controls, which change
 * what it says -- and they are separate functions. Elements are looked up per
 * call rather than closed over, so it is also safe from the overlay window,
 * where none of them exist.
 */
function renderConnection() {
    const badgeEl = document.getElementById('hosted-conn-badge');
    const connTextEl = document.getElementById('hosted-conn-text');
    const signInBtn = document.getElementById('hosted-signin-btn');
    const connectBtn = document.getElementById('hosted-connect-btn');
    const signOutBtn = document.getElementById('hosted-signout-btn');
    const quotaEl = document.getElementById('hosted-quota');

    const kind = tokenKind(common.settingsStore.get(DEVICE_TOKEN_KEY));
    const name = common.settingsStore.get(ACCOUNT_KEY)?.name;

    if (badgeEl) {
        badgeEl.textContent = { discord: 'Discord', anon: 'Anonymous', none: 'Not connected' }[kind];
        badgeEl.className = `conn-badge ${kind}`;
    }
    if (connTextEl) {
        connTextEl.textContent = {
            discord: name ? `Signed in as ${name}` : 'Signed in with Discord',
            anon: 'No account — clearing your settings will lose this connection',
            none: 'Sign in with Discord, or connect anonymously to try it'
        }[kind];
    }

    // Offer the anonymous button only when it is an upgrade or a start — never
    // as a way to downgrade an account you are already signed into.
    if (signInBtn) signInBtn.hidden = kind === 'discord';
    if (connectBtn) connectBtn.hidden = kind !== 'none';
    if (signOutBtn) signOutBtn.hidden = kind === 'none';

    if (quotaEl && kind === 'none') quotaEl.textContent = '';
}

/**
 * Provider picker and the OpenAI-compatible fields.
 *
 * These live OUTSIDE initSettingsForm on purpose. That binder keys on the
 * `name` attribute and loads stored values once at bind time, which suits a
 * fixed form; the preset dropdown has to WRITE two other fields when it
 * changes. setupPromptLibrary() already manages its controls the same way.
 */
function setupProviderControls() {
    const providerSel = document.querySelector('select[name="aiProvider"]');
    const presetSel = document.querySelector('select[name="compatPreset"]');
    const baseUrlInput = document.querySelector('input[name="compatBaseUrl"]');
    const hintEl = document.getElementById('compat-hint');

    const applyVisibility = () => {
        const id = activeProviderId();
        for (const el of document.querySelectorAll('[data-provider]')) {
            // Space-separated, so a row shared by two providers (the Test
            // Connection button) does not need a duplicate element.
            const owners = el.dataset.provider.split(/\s+/);
            el.classList.toggle('hidden', !owners.includes(id));
        }
        if (hintEl) hintEl.textContent = presetFor(activePresetId()).hint || '';
        renderConnection();
        updateApiInfo();
    };

    if (providerSel) {
        providerSel.value = activeProviderId();
        providerSel.addEventListener('change', () => {
            common.settingsStore.set('aiProvider', providerSel.value);
            applyVisibility();
        });
    }

    if (presetSel) {
        presetSel.value = activePresetId();
        presetSel.addEventListener('change', () => {
            const id = presetSel.value;
            common.settingsStore.set('compatPreset', id);
            // Writing the base URL here is the whole point of a preset. 'custom'
            // keeps whatever the user already typed.
            const cfg = presetFor(id);
            if (id !== 'custom') {
                common.settingsStore.set('compatBaseUrl', cfg.baseUrl);
                if (baseUrlInput) baseUrlInput.value = cfg.baseUrl;
            }
            applyVisibility();
        });
    }

    applyVisibility();
}

/**
 * The Lunatic hosted service.
 *
 * The model dropdown is filled from the service, so it is managed entirely
 * OUTSIDE initSettingsForm and carries no `name` attribute.
 * That binder loads values once at bind time; options that arrive later from a
 * fetch would leave the stored value unselected -- the ordering hazard already
 * documented above migrateModelSetting().
 */
function setupHostedControls() {
    const connectBtn = document.getElementById('hosted-connect-btn');
    const statusEl = document.getElementById('hosted-status');
    const quotaEl = document.getElementById('hosted-quota');
    const modelSel = document.getElementById('hosted-model');
    const baseInput = document.getElementById('hosted-base-url');
    const signInBtn = document.getElementById('hosted-signin-btn');
    const signOutBtn = document.getElementById('hosted-signout-btn');
    const linkEl = document.getElementById('hosted-signin-link');
    const badgeEl = document.getElementById('hosted-conn-badge');
    const connTextEl = document.getElementById('hosted-conn-text');
    let signingIn = false;

    if (!connectBtn && !modelSel) return;   // not the settings window

    const setStatus = (text, cls = '') => {
        if (statusEl) {
            statusEl.textContent = text;
            statusEl.className = cls;
        }
    };

    signOutBtn?.addEventListener('click', () => {
        // Local only. The account and its key live on the server; signing in
        // again returns the same one, so this cannot orphan an allowance.
        common.settingsStore.set(DEVICE_TOKEN_KEY, '');
        common.settingsStore.set(ACCOUNT_KEY, null);
        common.settingsStore.set(QUOTA_KEY, null);
        setStatus('Signed out', '');
        if (linkEl) linkEl.hidden = true;
        renderConnection();
        updateApiInfo();
    });

    const serviceUrl = () => {
        const raw = (baseInput?.value ?? common.settingsStore.get('hostedBaseUrl') ?? '').trim();
        return raw.replace(/\/+$/, '');
    };

    const fill = (sel, items, storedKey, fallback) => {
        if (!sel) return;
        sel.textContent = '';
        for (const it of items) {
            const opt = document.createElement('option');
            opt.value = it.id;
            // textContent, not innerHTML: these strings come off the network.
            opt.textContent = it.description ? `${it.label} — ${it.description}` : it.label;
            sel.append(opt);
        }
        const stored = common.settingsStore.get(storedKey) || fallback;
        if (items.some(i => i.id === stored)) sel.value = stored;
        else if (items.length) {
            // The stored choice is gone from the service -- move to a real one
            // rather than leaving a select whose value matches no option.
            sel.value = items[0].id;
            common.settingsStore.set(storedKey, items[0].id);
        }
    };

    async function getJson(path, options) {
        const url = serviceUrl();
        if (!url) throw new Error('Enter the service URL first');
        const res = await fetch(`${url}${path}`, options);
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.error?.message || `Service error ${res.status}`);
        return body;
    }

    /**
     * The same identity a commentary call sends.
     *
     * Without `X-Lunatic-Athlete` the service buckets this request by device
     * token while the overlay's calls are bucketed by athlete id, so the
     * allowance shown here described a bucket nothing had ever spent from --
     * "150 of 150 left" beside an overlay saying the monthly limit was reached.
     */
    const authHeader = () => {
        const headers = {
            Authorization: `Bearer ${common.settingsStore.get(DEVICE_TOKEN_KEY) || ''}`
        };
        const athleteId = common.settingsStore.get(ATHLETE_ID_KEY);
        if (athleteId) headers['X-Lunatic-Athlete'] = String(athleteId);
        return headers;
    };

    /** Pull the model list, the voices, and the remaining allowance. */
    async function refresh() {
        // Models only. The voice comes from the Voices tab now, and it is the
        // same list on every provider, so there is nothing to fetch for it.
        const models = await getJson('/v1/models');
        fill(modelSel, (models.data || []).map(m => ({
            id: m.id, label: m.label || m.id, description: m.description
        })), 'hostedModel', 'free-fast');

        const quota = await getJson('/v1/quota', { headers: authHeader() });
        // QUOTA_KEY is shared with the overlay, which renders its own readout
        // from it. Only write a number that describes the bucket commentary
        // spends from: if we know an athlete id but the service answered about
        // a device bucket (an older deployment that does not echo `bucket`, or
        // a header a proxy stripped), showing it here is one thing -- leaving
        // it in the overlay's tooltip is another.
        const athleteId = common.settingsStore.get(ATHLETE_ID_KEY);
        const wrongBucket = athleteId && typeof quota.bucket === 'string' &&
            quota.bucket.startsWith('d:');
        if (!wrongBucket) common.settingsStore.set(QUOTA_KEY, quota.remaining);
        if (quotaEl) {
            quotaEl.textContent = wrongBucket
                ? `${quota.remaining} of ${quota.limit} free calls left for this install`
                : `${quota.remaining} of ${quota.limit} free calls left this month`;
        }
        // The service is the authority on who the key belongs to; the stored
        // label is only a fallback for an offline settings window.
        if (quota.account?.name) {
            common.settingsStore.set(ACCOUNT_KEY, { name: quota.account.name });
        }
        renderConnection();
        return quota;
    }

    /**
     * Sign in with Discord, using the service's pairing flow.
     *
     * The overlay cannot receive an OAuth redirect, so the browser does the
     * sign-in and the mod polls for the result. The service issues a public
     * `code` for the URL and a secret `pollToken` that never leaves here, so
     * only this client can collect the key.
     */
    async function signIn() {
        const start = await getJson('/v1/pair/start', { method: 'POST' });
        if (!start?.verifyUrl || !start?.pollToken) throw new Error('The service did not start a sign-in');

        // Show the link before opening it: if the popup is blocked or opens
        // somewhere unhelpful, the rider still has something to click.
        if (linkEl) {
            linkEl.textContent = 'Open the sign-in page';
            linkEl.href = start.verifyUrl;
            linkEl.hidden = false;
        }
        try { window.open(start.verifyUrl, '_blank'); } catch (e) { /* link is the fallback */ }

        const deadline = Date.now() + Math.min(Number(start.expiresIn) || 900, 900) * 1000;
        while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 2000));
            const res = await getJson('/v1/pair/poll', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pollToken: start.pollToken })
            });
            if (res.status === 'complete') return res;
            if (res.status !== 'pending') {
                throw new Error('That sign-in link expired. Try again.');
            }
        }
        throw new Error('Timed out waiting for the sign-in to finish.');
    }

    signInBtn?.addEventListener('click', async () => {
        if (signingIn) return;              // one flow at a time
        signingIn = true;
        signInBtn.disabled = true;
        setStatus('Waiting for Discord…', 'loading');
        try {
            if (baseInput) common.settingsStore.set('hostedBaseUrl', serviceUrl());
            const { key, account } = await signIn();
            common.settingsStore.set(DEVICE_TOKEN_KEY, key);
            common.settingsStore.set(ACCOUNT_KEY, { name: account?.username || 'Discord user' });
            if (linkEl) linkEl.hidden = true;
            await refresh();
            setStatus(`Signed in as ${account?.username || 'Discord user'}`, 'success');
            updateApiInfo(true);
        } catch (err) {
            setStatus(err.message || 'Sign-in failed', 'error');
        } finally {
            signingIn = false;
            signInBtn.disabled = false;
        }
    });

    if (baseInput) {
        baseInput.value = common.settingsStore.get('hostedBaseUrl') || baseInput.value || '';
        common.settingsStore.set('hostedBaseUrl', serviceUrl());
        baseInput.addEventListener('change', () => {
            common.settingsStore.set('hostedBaseUrl', serviceUrl());
        });
    }

    connectBtn?.addEventListener('click', async () => {
        connectBtn.disabled = true;
        setStatus('Connecting…', 'loading');
        try {
            if (baseInput) common.settingsStore.set('hostedBaseUrl', serviceUrl());

            // Reuse an existing token. Minting a fresh one on every click would
            // look like a way to reset the allowance, and the service buckets on
            // the Zwift athlete id anyway, so it would only lose continuity.
            if (!common.settingsStore.get(DEVICE_TOKEN_KEY)) {
                const { token } = await getJson('/v1/device', { method: 'POST' });
                if (!token) throw new Error('The service did not return a token');
                common.settingsStore.set(DEVICE_TOKEN_KEY, token);
            }

            await refresh();
            setStatus('Connected', 'success');
            updateApiInfo(true);
        } catch (err) {
            setStatus(err.message || 'Could not reach the service', 'error');
        } finally {
            connectBtn.disabled = false;
        }
    });

    modelSel?.addEventListener('change', () => {
        common.settingsStore.set('hostedModel', modelSel.value);
        updateApiInfo();
    });

    // Already set up? Refresh quietly on open so the allowance is current.
    if (activeProviderId() === 'hosted' && isProviderConfigured()) {
        refresh().then(() => { setStatus('Connected', 'success'); updateApiInfo(true); })
                 .catch(err => setStatus(err.message || 'Service unreachable', 'error'));
    }
}

// ============================================================================
// The prompt library
// ============================================================================
// Built-in voices are read straight from prompts.mjs and never copied into the
// rider's settings, so an improved built-in is picked up automatically and a
// rider's own copy is never rewritten underneath them. Storage rules live in
// prompt-library.mjs; everything here is the settings tab on top of them.

/** A one-line status under the editor. Errors persist; successes fade. */
let promptStatusTimer = null;

function setPromptStatus(text, cls = '') {
    const el = document.getElementById('prompt-status');
    if (!el) return;
    clearTimeout(promptStatusTimer);
    el.textContent = text;
    el.className = cls;
    if (text && cls !== 'error') {
        promptStatusTimer = setTimeout(() => { el.textContent = ''; el.className = ''; }, 4000);
    }
}

/**
 * Rebuild the dropdown: built-ins first, then the rider's own, in two groups.
 *
 * Built from the tables rather than from markup, which is how the mod and the
 * service drifted apart in the first place -- and now the second group does not
 * exist until a rider makes it.
 */
function renderPromptPicker() {
    const sel = document.getElementById('style-preset');
    if (!sel) return;
    sel.textContent = '';

    const group = label => {
        const g = document.createElement('optgroup');
        g.label = label;
        sel.append(g);
        return g;
    };
    const option = (parent, value, text) => {
        const o = document.createElement('option');
        o.value = value;
        // textContent, not innerHTML: a rider names these.
        o.textContent = text;
        parent.append(o);
    };

    const builtins = group('Built-in');
    // The merged table: what the service last sent, over what the mod shipped
    // with. A voice added since this zip was built belongs in the list.
    //
    // A `<select>` cannot carry a badge, so a new arrival is marked in its own
    // label. It clears when the notice is dismissed, which is the same moment
    // the rider has acknowledged it.
    const fresh = new Set((promptUpdates.pendingNotice(common.settingsStore)?.added || [])
        .map(v => v.id));
    for (const p of library.listBuiltins(common.settingsStore)) {
        option(builtins, p.id, fresh.has(p.id) ? `${p.label} — new` : p.label);
    }

    const own = library.listUserPrompts(common.settingsStore);
    if (own.length) {
        const mine = group('Your prompts');
        for (const p of own) option(mine, p.id, p.name);
    }

    sel.value = activePromptId();
}

/**
 * Show the selected prompt. One function for both kinds: `readOnly` is the only
 * thing that differs, so there is no second code path to keep in step.
 */
function renderPromptEditor() {
    const store = common.settingsStore;
    const p = library.resolvePrompt(store);
    const el = id => document.getElementById(id);
    const show = (id, on) => { const n = el(id); if (n) n.hidden = !on; };

    const nameInput = el('prompt-name');
    const sysInput = el('custom-system-prompt');
    const userInput = el('custom-user-prompt');
    if (!sysInput) return;                      // not the settings window

    if (el('prompt-description')) el('prompt-description').textContent = p.description;
    if (el('prompt-editor-title')) {
        el('prompt-editor-title').textContent = p.kind === 'user' ? p.name : `${p.name} — read only`;
    }
    if (nameInput) nameInput.value = p.kind === 'user' ? p.name : '';
    sysInput.value = p.systemPrompt;
    userInput.value = p.userPromptTemplate;
    // readOnly rather than disabled: a rider must still be able to select the
    // text of a built-in and copy it out.
    sysInput.readOnly = p.readOnly;
    userInput.readOnly = p.readOnly;

    show('prompt-name-row', !p.readOnly);
    show('prompt-save-btn', !p.readOnly);
    show('prompt-delete-btn', !p.readOnly);
    show('prompt-readonly-note', p.readOnly);
    // Only a copy has something to reset to.
    show('prompt-revert-btn', !p.readOnly && !!p.from);

    renderPromptProviderNote(p);
    renderStaleNotice(p);
    resetDeleteButton();
    setPromptStatus('');
}

/**
 * "The voice you copied has been improved since."
 *
 * Their text is not touched and never will be -- this is the whole point of
 * keeping built-ins out of a rider's settings. It only tells them, so they can
 * look at the change and decide; Reset to source is right there if they want it.
 */
function renderStaleNotice(p = library.resolvePrompt(common.settingsStore)) {
    const box = document.getElementById('prompt-stale');
    const text = document.getElementById('prompt-stale-text');
    const view = document.getElementById('prompt-stale-diff-view');
    if (!box || !text) return;

    const stale = library.staleCopies(common.settingsStore).find(c => c.id === p.id);
    box.hidden = !stale;
    if (view) view.hidden = true;
    if (!stale) return;

    text.textContent = `${stale.sourceLabel} has been improved since you copied it ` +
        `(version ${stale.had} to ${stale.now}). Your version is untouched — ` +
        `“Reset to source” below would replace it with the new original.`;
}

/** What the rider has, against the source as it stands now. */
function staleDiffParts() {
    const store = common.settingsStore;
    const p = library.resolvePrompt(store);
    if (!p.from) return [];
    return diffPrompts(p, library.builtinFor(store, p.from.id));
}

/**
 * Say, next to the editor, whether this prompt is actually what gets sent.
 *
 * On the free hosted tier the service substitutes its own system message, so a
 * rider's own prompt is discarded there. That was buried in help text on two
 * other tabs; it belongs beside the box they typed it into.
 */
function renderPromptProviderNote(p = library.resolvePrompt(common.settingsStore)) {
    const note = document.getElementById('prompt-provider-note');
    if (!note) return;
    const provider = activeProvider().label;
    if (activeProviderId() !== 'hosted') {
        note.textContent = `Sent as written, on ${provider}.`;
        note.className = 'help-text';
        return;
    }
    if (p.kind === 'builtin') {
        note.textContent = `On ${provider} the service supplies this voice. Same voice, same words.`;
        note.className = 'help-text';
    } else {
        const heard = promptFor(library.hostedStyleFor(common.settingsStore)).label;
        note.textContent = `On ${provider} the service supplies the announcer's instructions, ` +
            `so this prompt is not used — you will hear ${heard}. Switch to your own API key on the ` +
            `AI Provider tab to use it.`;
        note.className = 'help-text warn';
    }
}

/** Delete is two clicks, not a dialog: confirm() can be suppressed in Electron. */
function resetDeleteButton() {
    const btn = document.getElementById('prompt-delete-btn');
    if (!btn) return;
    btn.textContent = 'Delete';
    btn.dataset.armed = '';
}

/**
 * Render a prompt diff into a container.
 *
 * Built with createElement rather than innerHTML: every line here is prompt
 * text, and some of it is text a rider typed. Colour is doubled by a +/-
 * gutter, because red-and-green alone is not a signal everyone can read.
 */
function renderDiff(container, parts) {
    if (!container) return;
    container.textContent = '';
    if (!parts.length) {
        const p = document.createElement('div');
        p.className = 'diff-gap';
        p.textContent = 'The wording is identical — only the version number moved.';
        container.append(p);
        return;
    }
    for (const part of parts) {
        const field = document.createElement('div');
        field.className = 'diff-field';

        const label = document.createElement('div');
        label.className = 'diff-field-label';
        label.textContent = `${part.label} — ${part.added} added, ${part.removed} removed`;
        field.append(label);

        for (const h of part.hunks) {
            if (h.type === 'gap') {
                const gap = document.createElement('div');
                gap.className = 'diff-gap';
                gap.textContent = `… ${h.count} unchanged lines`;
                field.append(gap);
                continue;
            }
            const line = document.createElement('div');
            line.className = `diff-line ${h.type}`;
            const gutter = document.createElement('span');
            gutter.className = 'gutter';
            gutter.textContent = { add: '+', del: '-', same: ' ' }[h.type];
            const text = document.createElement('span');
            text.textContent = h.text;
            line.append(gutter, text);
            field.append(line);
        }
        container.append(field);
    }
}

/** Expand or collapse a diff panel, filling it the first time it is opened. */
function toggleDiff(viewId, buildParts) {
    const view = document.getElementById(viewId);
    if (!view) return;
    if (view.hidden) {
        renderDiff(view, buildParts());
        view.hidden = false;
    } else {
        view.hidden = true;
    }
}

/**
 * The "a voice was improved" line at the top of the Voices tab.
 *
 * A line on the tab a rider is already looking at, dismissible, and nothing in
 * the overlay -- an announcer changing wording is news, not an interruption
 * mid-race.
 */
function renderPromptNotice() {
    const box = document.getElementById('prompt-notice');
    const text = document.getElementById('prompt-notice-text');
    if (!box || !text) return;
    const notice = promptUpdates.pendingNotice(common.settingsStore);
    box.hidden = !notice;
    text.textContent = notice ? promptUpdates.describeNotice(notice) : '';

    // Only offer the diff when something was rewritten. A brand-new voice has
    // no previous text, so there would be nothing on the left-hand side.
    const diffBtn = document.getElementById('prompt-notice-diff');
    if (diffBtn) diffBtn.hidden = !notice?.updated?.length;
    const view = document.getElementById('prompt-notice-diff-view');
    if (view) view.hidden = true;
}

/** Every rewritten voice in the pending notice, old text against new. */
function noticeDiffParts() {
    const store = common.settingsStore;
    const notice = promptUpdates.pendingNotice(store);
    const parts = [];
    for (const u of notice?.updated || []) {
        const before = library.previousBuiltin(store, u.id);
        const after = library.builtinFor(store, u.id);
        if (!before) continue;
        for (const part of diffPrompts(before, after)) {
            parts.push({ ...part, label: `${u.label} · ${part.label}` });
        }
    }
    return parts;
}

/**
 * Ask the service whether the built-in voices have moved on.
 *
 * Deliberately not awaited by the caller: the settings window must open at once
 * whether the service answers in 50ms, in six seconds, or never. Whatever comes
 * back re-renders what is already on screen.
 */
function checkPromptUpdates() {
    promptUpdates.checkForUpdates(common.settingsStore)
        .then(result => {
            if (result.status !== 'updated') return;
            renderPromptPicker();
            renderPromptEditor();
            renderPromptNotice();
            renderHelpVoices();
        })
        .catch(err => console.warn('[Lunatic] prompt update check failed:', err));
}

/**
 * Point every link to the online help at the service actually in use.
 *
 * Not hardcoded: the base URL is a setting, and someone running their own
 * deployment should reach their own page — which is also the only one whose
 * quotas and model list will match what they are getting.
 */
function renderHelpLink() {
    const url = `${promptUpdates.serviceUrlFor(common.settingsStore)}/help`;
    for (const link of document.querySelectorAll('.help-online-link')) link.href = url;
}

/**
 * The list of built-in voices on the Help tab, from the library rather than
 * from prose.
 *
 * Help used to carry a hand-written list. It drifted: by v0.8.2 it named two
 * of four voices and described the pre-library design where a hosted rider
 * picked a voice somewhere else. library.listBuiltins() is the server cache
 * over the bundled table, so a voice the service adds or rewords shows up here
 * the day it arrives.
 */
function renderHelpVoices() {
    const dl = document.getElementById('help-voices');
    if (!dl) return;
    dl.textContent = '';                        // replace, never append
    for (const v of library.listBuiltins(common.settingsStore)) {
        const dt = document.createElement('dt');
        dt.textContent = v.label;
        const dd = document.createElement('dd');
        dd.textContent = v.description;
        dl.appendChild(dt);
        dl.appendChild(dd);
    }
}

function setupPromptLibrary() {
    const store = common.settingsStore;
    const sel = document.getElementById('style-preset');
    if (!sel) return;                           // not the settings window

    /** Run a library call, refresh the tab, and put any refusal on screen. */
    const act = (fn, done) => {
        try {
            const result = fn();
            renderPromptPicker();
            renderPromptEditor();
            if (done) setPromptStatus(done, 'success');
            return result;
        } catch (err) {
            setPromptStatus(err.message || 'That did not work', 'error');
            return null;
        }
    };

    sel.addEventListener('change', () => {
        library.setActive(store, sel.value);
        renderPromptEditor();
    });

    document.getElementById('prompt-duplicate-btn')?.addEventListener('click', () => {
        act(() => {
            const id = library.duplicatePrompt(store, activePromptId());
            library.setActive(store, id);
            return id;
        }, 'Copied — edit it below and save.');
    });

    document.getElementById('prompt-new-btn')?.addEventListener('click', () => {
        act(() => {
            const id = library.newBlankPrompt(store);
            library.setActive(store, id);
            return id;
        }, 'Started a new prompt.');
    });

    document.getElementById('prompt-delete-btn')?.addEventListener('click', ev => {
        const btn = ev.currentTarget;
        if (!btn.dataset.armed) {
            btn.dataset.armed = '1';
            btn.textContent = 'Really delete?';
            setPromptStatus('Click again to delete. This cannot be undone.', 'warn');
            return;
        }
        act(() => library.deletePrompt(store, activePromptId()), 'Deleted.');
    });

    document.getElementById('prompt-save-btn')?.addEventListener('click', () => {
        act(() => library.updatePrompt(store, activePromptId(), {
            name: document.getElementById('prompt-name')?.value,
            systemPrompt: document.getElementById('custom-system-prompt')?.value,
            userPromptTemplate: document.getElementById('custom-user-prompt')?.value
        }), 'Saved.');
    });

    document.getElementById('prompt-revert-btn')?.addEventListener('click', () => {
        act(() => library.revertToSource(store, activePromptId()), 'Reset to the original.');
    });

    // Typing arms Save and disarms Delete: a half-typed prompt should not be one
    // stray click from being thrown away.
    for (const id of ['prompt-name', 'custom-system-prompt', 'custom-user-prompt']) {
        document.getElementById(id)?.addEventListener('input', () => {
            resetDeleteButton();
            setPromptStatus('Unsaved changes', 'warn');
        });
    }

    document.getElementById('prompt-notice-diff')?.addEventListener('click', () => {
        toggleDiff('prompt-notice-diff-view', noticeDiffParts);
    });

    document.getElementById('prompt-stale-diff')?.addEventListener('click', () => {
        toggleDiff('prompt-stale-diff-view', staleDiffParts);
    });

    document.getElementById('prompt-notice-dismiss')?.addEventListener('click', () => {
        promptUpdates.dismissNotice(store);
        renderPromptPicker();
        renderPromptNotice();
    });

    const updatesSel = document.getElementById('prompt-updates');
    if (updatesSel) {
        updatesSel.value = promptUpdates.updatesEnabled(store) ? 'auto' : 'off';
        updatesSel.addEventListener('change', () => {
            common.settingsStore.set(promptUpdates.UPDATES_KEY, updatesSel.value);
            if (updatesSel.value === 'auto') checkPromptUpdates();
        });
    }

    renderPromptPicker();
    renderPromptEditor();
    renderPromptNotice();
    // Fire and forget. Cached-then-refresh: the tab is already correct from the
    // cache, and a check that lands later re-renders it.
    checkPromptUpdates();
}

function updateCustomColorVisibility() {
    const option = common.settingsStore.get('backgroundOption') || 'transparent';
    const row = document.querySelector('.custom-color-row');

    if (row) {
        row.style.display = option === 'custom' ? 'flex' : 'none';
    }

    // Also listen for changes
    const select = document.querySelector('select[name="backgroundOption"]');
    if (select) {
        select.addEventListener('change', () => {
            const row = document.querySelector('.custom-color-row');
            if (row) {
                row.style.display = select.value === 'custom' ? 'flex' : 'none';
            }
        });
    }
}

function setupDataFields() {
    // This tab has no <form>, so nothing here is bound by initSettingsForm.
    const checkboxes = document.querySelectorAll('.field-checkbox input[type="checkbox"]');

    checkboxes.forEach(checkbox => {
        const name = checkbox.name;
        if (name) {
            checkbox.checked = common.settingsStore.get(name) ?? checkbox.checked;
            checkbox.addEventListener('change', () => {
                common.settingsStore.set(name, checkbox.checked);
            });
        }
    });

    const power = document.querySelector('select[name="powerMode"]');
    if (power) {
        power.value = powerMode();
        power.addEventListener('change', () => common.settingsStore.set('powerMode', power.value));
    }

    renderStoredDataStatus();
}

/**
 * Say whether the GOTTA.BIKE import this section reads has anything in it.
 *
 * These boxes read a key a DIFFERENT mod writes (ATHLETE_DATA_KEY is global and
 * read-only here). Without GOTTA.BIKE Sauce installed and populated every one is
 * a no-op, three of them ship ticked, and there was no way to tell short of
 * listening for FTP in the commentary. The settings window did not even load the
 * data -- only the overlay did.
 */
function renderStoredDataStatus() {
    const line = document.getElementById('stored-data-status');
    const section = document.getElementById('stored-data-section');
    if (!line) return;

    const count = Object.keys(storedAthleteData || {}).length;
    line.textContent = '';
    if (count) {
        line.appendChild(document.createTextNode(
            `Reads the data the GOTTA.BIKE Sauce mod imports. Stored data for ${count} ` +
            `${count === 1 ? 'rider' : 'riders'} found.`));
    } else {
        line.appendChild(document.createTextNode(
            'GOTTA.BIKE Sauce is not installed, or has imported nothing yet — these fields do ' +
            'nothing until it does. '));
        const link = document.createElement('a');
        link.href = 'https://github.com/vincentdavis/GOTTA_BIKE_sauce';
        link.target = '_blank';
        link.rel = 'noreferrer';
        link.textContent = 'Get\u00a0it';
        line.appendChild(link);
    }
    // Dimmed, not hidden: a rider who ticked these should still find them.
    section?.classList.toggle('inert', !count);
}

/** getVoices() is often empty on the first synchronous call. */
function populateVoicePicker() {
    return new Promise(resolve => {
        /** One unselectable option, in place of an empty dropdown. */
        const placeholder = text => {
            const sel = document.getElementById('tts-voice');
            if (!sel) return;
            sel.textContent = '';
            const opt = document.createElement('option');
            opt.textContent = text;
            opt.disabled = true;
            sel.appendChild(opt);
            sel.value = '';
        };

        const fill = () => {
            const sel = document.getElementById('tts-voice');
            if (!sel) return resolve();
            const voices = listVoices();
            // getVoices() is legitimately empty for the first moments in a
            // browser, so this is not yet "no voices" -- but an unexplained
            // empty dropdown is never right either. Say what is happening, and
            // replace it either with the voices or with the verdict below.
            if (!voices.length) return placeholder('Looking for voices\u2026');
            const stored = common.settingsStore.get('ttsVoice') || '';
            sel.innerHTML = '';
            for (const v of voices) {
                const opt = document.createElement('option');
                opt.value = v.name;
                opt.textContent = `${v.name} (${v.lang})`;
                sel.appendChild(opt);
            }
            if (stored && voices.some(v => v.name === stored)) {
                sel.value = stored;
            } else {
                const fallback = pickVoice();
                if (fallback) sel.value = fallback.name;
            }
            resolve();
        };
        fill();
        if (typeof speechSynthesis !== 'undefined') {
            speechSynthesis.addEventListener('voiceschanged', fill, { once: true });
        }
        // They are not coming. Now it IS "no voices", and the dropdown says so.
        setTimeout(() => {
            if (!listVoices().length) placeholder('No voices found on this computer');
            resolve();
        }, 3000);
    });
}

/** Where to install a voice, per platform. Both, because the mod runs on both. */
const VOICE_HELP = 'Mac: System Settings \u203a Accessibility \u203a Spoken Content \u203a Manage Voices. ' +
    'Windows: Settings \u203a Time & Language \u203a Speech \u203a Add voices.';

function setupVoiceTest() {
    const btn = document.getElementById('test-voice-btn');
    if (!btn) return;
    const status = document.getElementById('voice-test-status');
    const setStatus = (text, cls = '') => {
        if (!status) return;
        status.textContent = text;
        status.className = cls;
    };

    btn.addEventListener('click', () => {
        cancelSpeech();
        ttsVoice = pickVoice();

        // The failure this control exists to report. Without it the button did
        // nothing, said nothing, and left a rider to conclude the mod was
        // broken -- when the machine simply has no voice installed.
        if (!ttsVoice) {
            setStatus(`No voices found on this computer. ${VOICE_HELP}`, 'error');
            return;
        }

        setStatus(`Speaking\u2026 (${ttsVoice.name})`, 'loading');
        // force: an explicit test speaks whether or not the setting is on.
        const u = speak(
            'And Rodriguez goes! Six hundred and forty watts, and he has cracked the front group wide open.',
            { force: true });

        if (!u) {
            setStatus('This window cannot speak — speech synthesis is unavailable.', 'error');
            return;
        }
        u.onend = () => setStatus('');
        // speak() already logs; this is the half a rider needs to see.
        const wasOnError = u.onerror;
        u.onerror = ev => {
            wasOnError?.(ev);
            if (ev.error === 'interrupted' || ev.error === 'canceled') return setStatus('');
            setStatus(`Could not speak: ${ev.error || 'unknown error'}. ${VOICE_HELP}`, 'error');
        };
    });
}

function setupCostReset() {
    const resetBtn = document.getElementById('reset-cost-btn');

    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            // Reset the shared counters; the main window's 'set' listener picks
            // this up and clears its own accumulator too.
            sessionCost = 0;
            totalCalls = 0;
            common.settingsStore.set(COST_KEY, 0);
            common.settingsStore.set(CALLS_KEY, 0);
            renderCost();
        });
    }
}
