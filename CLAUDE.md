# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

A single-window Sauce4Zwift mod: an AI race announcer. Pure HTML/CSS/JS served by
Sauce — **no build step, no npm, no bundler**. `local_build.sh` only zips files.

Extracted from `GOTTA_BIKE_sauce` (commits `cf8f362`, `0ae6e15`), where it shipped
as the "Live Commentary" window.

## Layout

```
manifest.json              mod metadata + the single window definition
pages/announcer.html       overlay window
pages/announcer-settings.html  settings (Settings/API/Prompts/Data/Help tabs)
pages/src/announcer.mjs    all logic (~1900 lines)
pages/src/prompts.mjs      the built-in announcer voices (leaf module)
pages/src/prompt-library.mjs   the rider's own prompts + the server cache; takes the store
pages/src/prompt-updates.mjs   the daily check against GET /v1/prompts
pages/src/prompt-diff.mjs      an LCS line diff, for showing what changed
pages/css/announcer.css    styles
pages/images/logo.svg      source of truth for the logo; PNGs are rendered from it
scripts/lib/stub-dom.mjs   a DOM + Sauce `common` small enough to boot the mod in Node
scripts/lib/browser-common-stub.mjs   the same `common` stub, for a real browser
scripts/lib/sauce-common-approx.css   an APPROXIMATION of Sauce's base stylesheet
scripts/settings-shots.mjs  screenshots every settings-window state in Chromium at 700×600
scripts/settings-boot-test.mjs  boots the settings window
scripts/overlay-boot-test.mjs   boots the overlay, incl. the ~1Hz nearby handler
scripts/prompt-migration-test.mjs  legacy voice ids land where they should
scripts/prompt-parity-test.mjs     the mod and the service define the same voices
scripts/prompt-library-test.mjs    the library's storage rules, driven directly
scripts/prompt-updates-test.mjs    the update check, against the real service handler
scripts/prompt-diff-test.mjs       the line diff and "your copy is behind" 
```

Run **both** boot tests after touching `announcer.mjs`. They are the only things
that *execute* the mod's UI code — `node --check` passes happily on a window that
throws the instant it opens, which is how v0.4.0 shipped with every provider's
fields (API key included) visible at once. Separate processes, because
`announcer.mjs` holds module-level state and migrates at import. CI and
`local_build.sh` run both.

The stub `settingsStore` really dispatches `changed` and `set`, so a test can drive
the live-update paths the way the settings window does — which is how the overlay's
stale cost readout was found.

To *see* the settings window rather than merely execute it, `node
scripts/settings-shots.mjs` serves `pages/` with the browser stub and a mock of the
hosted service, drives 14 states (each tab, each provider, connected/anonymous/Discord,
the prompt editor, the update notice with its diff open) and writes viewport +
full-page PNGs to `build/shots/`. Needs a global Playwright; deliberately not in CI.
Sauce opens the window at **700×600** — judge everything at that size. The base
stylesheet is an approximation and `<ms>` icons are placeholder glyphs; the mod's own
`announcer.css` is real. Set `CHROMIUM_PATH` if the machine's browser build does not match its
Playwright version — the harness never downloads one.

Both HTML files import the same module and call different entry points:
`lunaticAnnouncerMain()` and `lunaticAnnouncerSettingsMain()`.

## Sauce4Zwift API notes (hard-won — do not re-derive)

- `common.initSettingsForm(sel)` returns a callback that **must be invoked**:
  `await common.initSettingsForm('#form')()`. Without the trailing `()` the form
  never loads values *and* every edit throws before saving.
- **A negative `gap` means the rider is AHEAD of you.** Sauce sign-flips when
  `rp.reversed`, which is exactly the "ahead" branch. Never emit a bare signed
  number into a prompt — say "up the road" / "adrift".
- `nearby` is **already sorted front-to-back**. Do not re-sort by `|gap|`; that
  interleaves riders ahead and behind and destroys road order.
- `stats.power.smooth[5]/[60]` are live rolling averages. `stats.power.peaks[n]`
  are session-lifetime maxima that only ratchet up — never label them as recent.
- `stats.hr.max` is the session-observed max (starts at 0), **not** the rider's
  ceiling. Use stored `maxHR` or `athlete.maxHeartRate`.
- `state.speed` is already km/h. `state.grade` is a ratio, not a percent.
- Helpers shared by `setupProviderControls()` and `setupHostedControls()` belong at
  **module** scope. Both halves of the settings page touch the same connection row,
  and a helper closing over one function's `const` elements is a `ReferenceError`
  that aborts the whole setup — silently, since nothing else in the page notices.
- Settings bags are namespaced by window-**instance** id, not by
  `data-settings-key`. A different mod can never see another's bag via
  `settingsStore` — only a raw `localStorage` scan can (see `migrateLegacySettings`).
- `service/src/logo.mjs` is a byte-identical copy of `pages/images/logo.svg`, for the
  pages the service renders. Same constraint, same parity test.
- **`pages/src/prompts.mjs` and `service/src/styles.mjs` must stay byte-identical.**
  The mod ships only `pages/`, the service only `service/`, so neither can import
  the other and the table is written twice. `scripts/prompt-parity-test.mjs` is what
  enforces it — a comment asking a human to do it already failed silently, leaving
  three of four voices reachable on only one side.
- There is **one** voice setting, `stylePreset`, for every provider. It holds either a
  built-in id or a `usr-` library id. `hostedStyle` and `customSystemPrompt` /
  `customUserPrompt` are migrated-away legacy keys: never write them, and never delete
  them either — they are what a downgrade reads.
- **Built-in prompts are never copied into a rider's settings.** The mod reads their
  text from `library.builtins(store)` every time — the server cache over the bundled
  table — so improving one is automatic and a rider's own copy is never rewritten
  underneath them. Only what a rider wrote is stored.
- `prompts.mjs` is the **bundled floor**: never read it directly for a rider-facing
  decision, or you skip the improvements the service sent. Use `library.builtins()`,
  `library.builtinFor()` or `library.listBuiltins()`.
- The update check runs **only in the settings window**, never on overlay boot — the
  overlay fires commentary within a second of ride data and must not wait on a fetch.
  It reads the cache and nothing else.
- The check is anonymous by contract: no token, no account, no athlete id, no query
  string. `prompt-updates-test.mjs` asserts that on the real request; keep it true.
- The cache keeps a `previous` copy of **only the voices that changed**, so the notice
  has a left-hand side to diff against. Dismissing the notice drops it — a settings bag
  must not carry a second copy of the prompt table forever.
- Diff lines are built with `createElement`, never `innerHTML`: some of that text is
  what a rider typed. Colour is doubled by a `+`/`-` gutter, since red-and-green alone
  is not a signal everyone can read.
- **Every prompt migration lives in `migratePrompts()`, behind one flag, and runs
  once** — in *both* entry points. Two of them once sat in `migrateModelSetting()`,
  which runs on every window open; that would have reimposed an old hosted voice any
  time a rider returned to the default, and wiped a `usr-` id the day the library
  landed. `activeId()` already falls back at read time, so nothing needs re-running.
- **The Status box on the AI Provider tab goes green only when a request succeeded.**
  `updateApiInfo(true)` is the sole way in (Test Connection, Connect, sign-in, the
  hosted on-open refresh); any provider setting changing afterwards downgrades it to
  "changed since the last test" via the settings window's store listener. It used to
  be green whenever a key field had text, so a mistyped key looked like success.
- **The overlay must start when a provider becomes usable, not only at boot.** The gear
  lives on the overlay, so every first-run rider configures their key with the overlay
  open; `startCommentary()` fires on the false→true edge of `isProviderConfigured()` in
  the overlay's store listener. Honour `commentaryPaused` there — a deliberate pause
  survives a provider swap.
- **Every hosted request must carry the same identity.** The service buckets an
  anonymous rider by athlete id when `X-Lunatic-Athlete` is present and by device
  token when it is not, so a request that omits it asks about a *different* allowance.
  Only the overlay subscribes to `nearby`, so it publishes the id to
  `ATHLETE_ID_KEY` and `authHeader()` reads it. `/v1/quota` echoes `bucket` so the
  client can refuse to overwrite the shared `QUOTA_KEY` from the wrong one.
- **Nothing rider-facing states the voice list, or any other table, in prose.** The Help tab
  renders `#help-voices` from `library.listBuiltins()`; the online page renders its list from
  `listStyles()`. A hand-written copy is what left Help naming two of four voices and describing
  the pre-library design a year after it was migrated away (F08).
- There is **one** rider-facing word for the announcer persona: *voice*. The tab is **Voices**,
  its heading is **Voice**, and the text-to-speech picker is **Speaking voice** — never plain
  "Voice", or a rider picks Old Pro and wonders why Samantha still reads it.
- `renderHelpLink()` points every element with class **`.help-online-link`** at
  `serviceUrlFor(store) + '/help'`. Add a link to the online help anywhere and it follows a
  rider's own deployment for free; do not hardcode the public URL.
- Anthropic's rates live in **one** place the mod bills from: `anthropic.models` in
  `providers.mjs`, per 1K. The settings window carries only the one-line summary beside the
  Model select; the full per-1M table is on the service's help page and must stay in step.
- Keys with a leading `/` are **global and shared across all mods** on the Sauce
  origin. That is why `ATHLETE_DATA_KEY` can read GOTTA.BIKE's imported data, and
  why our own counters must NOT reuse GOTTA's key strings.

## Anthropic API notes

- Model IDs from the 4.6 generation on are **dateless**, and each dateless ID is
  itself a pinned snapshot. Appending a date suffix produces a 404.
- `migrateModelSetting()` falls back if a stored model ID leaves `TOKEN_COSTS`.
  Note it cannot catch a *retired* ID that is still a key in that table.
- **Do not add prompt caching.** Haiku 4.5's minimum cacheable prefix is 4096
  tokens; this request is ~700, so `cache_control` is accepted and silently does
  nothing.
- `output_config.effort` is **not supported on Haiku 4.5** and returns 400.
- Sonnet 5 / Opus 5 run adaptive thinking by default — selecting them without
  disabling it gives a much longer blank overlay.

## Storage keys

```javascript
'/gotta-bike-lunatic-settings'       // reserved (currently unused constant)
'/gotta-bike-lunatic-session-cost'   // shared cost counter
'/gotta-bike-lunatic-total-calls'    // shared call counter
'/gotta-bike-lunatic-migrated'       // one-time migration flag
'promptLibrary'                      // per-window: the rider's own prompts
'promptLibraryMigrated'              // per-window: prompt migrations ran
'builtinPrompts'                     // per-window: voices fetched from the service
'promptUpdates'                      // per-window: 'auto' (default) | 'off'
'promptUpdateNotice'                 // per-window: the undismissed "voices updated" line
'settingsTab'                        // per-window: the tab the settings window last showed
'/gotta-bike-lunatic-athlete-id'     // the overlay's watched athlete; the settings window's bucket
'/gotta-bike-sauce-athlete-data'     // READ-ONLY, written by GOTTA.BIKE sauce
'lunatic-announcer-settings-v1'      // per-window bag (data-settings-key)
```

## Releasing

Version lives in `manifest.json`. Tag `vX.Y.Z` to release; CI fails the release if
the tag and manifest disagree.
