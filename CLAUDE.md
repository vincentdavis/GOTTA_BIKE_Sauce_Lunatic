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
pages/css/announcer.css    styles
pages/images/logo.svg      source of truth for the logo; PNGs are rendered from it
scripts/settings-boot-test.mjs  runs the settings window against a stub DOM
```

Run `node scripts/settings-boot-test.mjs` after touching `announcer.mjs`. It is the
only thing that *executes* the mod's UI code — `node --check` passes happily on a
settings window that throws the instant it opens, which is how v0.4.0 shipped with
every provider's fields (API key included) visible at once. CI and `local_build.sh`
both run it.

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
'/gotta-bike-sauce-athlete-data'     // READ-ONLY, written by GOTTA.BIKE sauce
'lunatic-announcer-settings-v1'      // per-window bag (data-settings-key)
```

## Releasing

Version lives in `manifest.json`. Tag `vX.Y.Z` to release; CI fails the release if
the tag and manifest disagree.
