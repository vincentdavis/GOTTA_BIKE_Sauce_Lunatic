# Plan: a versioned, server-updatable prompt library

Two features, one substrate:

1. The mod picks up **improved and new announcer voices from the service**, without
   anyone downloading a new zip.
2. Riders can **copy, edit, create and save their own prompts** — a library, not the
   single slot there is today.

---

## 0. Where things actually stand

Worth being precise, because the current state is messier than it looks.

**There are two prompt sets, and they disagree.**

| | mod (`announcer.mjs`) | service (`styles.mjs`) |
|---|---|---|
| Tour de France | `ANNOUNCER_PRESET` | `tour` |
| Lunatic | — | `lunatic` |
| Old Pro | — | `domestique` |
| Tactical Coach | `tactical` | — |

`styles.mjs` claims it is "kept deliberately in sync with `ANNOUNCER_PRESET`". Only
`tour` is. A rider on their own Anthropic key **cannot reach Lunatic or Old Pro at
all** — the two voices the mod is named after. A hosted rider cannot reach Tactical
Coach. Nobody has ever been told this.

**Legacy keys clutter the picture.** `professional`, `casual` and `dramatic` are three
`stylePreset` values that all alias to the same object; only `dramatic` appears in the
dropdown. `custom` is a single editable pair, `customSystemPrompt` /
`customUserPrompt` — one slot, no name, no second one, no way back to what it was.

**`/v1/styles` returns labels only** — `id`, `label`, `description`, never the text.
That is deliberate and correct for the hosted tier, and it is exactly why it cannot
serve the first feature on its own.

**The distribution constraint is the whole reason this matters.** A Sauce mod updates
only when a rider downloads a new zip. Right now, improving the Tour prompt reaches
existing BYOK installs never. That is the problem worth solving.

---

## 1. The two update paths are not the same problem

This is the fork the plan turns on.

**Hosted (free tier).** The server already owns the system prompt — `handleChat`
discards the client's and substitutes `styleFor(body.style)`. Improving a hosted voice
is a `styles.mjs` edit and a deploy. Every hosted rider gets it on their next call,
today, with **zero client work**. Nothing in this plan is needed for that.

**BYOK (Anthropic / OpenAI-compatible).** The client builds and sends the system
prompt itself. The service never sees the call. This is the only path where "fetch
prompt definitions from the server" means anything — and it is the path where a stale
prompt persists forever.

So the shape is: **the service becomes the source of truth for the built-in library;
BYOK clients fetch the full text; hosted clients keep fetching labels only** (their
text arrives at call time, as it already does).

---

## 2. Data model

### Built-in prompts are never copied into user storage

The important simplification. The mod stores only *which version it last saw*; the
text always comes from cache-or-bundle. "Adopting v2" is then automatic by
construction — there is no stale copy to reconcile, and no merge to get wrong.

Versioning buys exactly two things: a "voices updated" note, and the ability to tell
a rider whose copy was taken from v1 that the source is now v3.

### Records

```js
// A built-in, as served and as cached. Read-only in the UI.
{ id: 'tour', version: 3, label: 'Tour de France',
  description: 'The classic television booth…',
  systemPrompt: '…', userPromptTemplate: '…',
  changelog: 'Tighter rules on how numbers are spoken.' }

// One of the rider's own. Created only by Duplicate or New.
{ id: 'usr-3f9a', name: 'My Tour call',
  systemPrompt: '…', userPromptTemplate: '…',
  from: { id: 'tour', version: 3 },   // provenance — powers "the source has moved on"
  updatedAt: 1757000000000 }
```

### Storage keys

```js
'promptLibrary'    // { version: 1, items: { 'usr-3f9a': {…} } }   the rider's own
'builtinPrompts'   // { revision, etag, fetchedAt, items: { tour: {…} } }  server cache
'activePromptId'   // 'tour' | 'usr-3f9a'
'promptUpdates'    // 'auto' | 'off'   — see §6
'stylePreset'      // LEGACY. Migrated, then left alone.
```

**Shipped differently:** there is no `activePromptId`. `stylePreset` was widened to
hold either kind of id instead. A new key would have meant a second migration, a
second legacy key, and a *worse* downgrade — a v0.5.0 build reading a `usr-` id falls
back to Tour de France, whereas it would have read a stale `stylePreset` and picked
some unrelated voice. Renaming it was only ever cosmetic.

Also shipped: `promptLibraryMigrated`, the one flag every prompt migration sits
behind. Phase 1 had left two of them in `migrateModelSetting()`, which runs on every
window open — so an old hosted-voice choice would have been reimposed any time a rider
returned to the default, and the unknown-id reset would have wiped a `usr-` id the day
the library landed. Both are one-shot now, in both entry points, and `activeId()`
handles the rest at read time.

Caps, because this is `localStorage` behind Sauce's `settingsStore`: **20 user prompts,
16 KB each**. Enforced at save with a real message, not silently.

### Migration (`migratePromptSettings()`, alongside `migrateModelSetting()`)

| stored `stylePreset` | becomes |
|---|---|
| `professional` / `casual` / `dramatic` | `activePromptId = 'tour'` |
| `tactical` | `activePromptId = 'tactical'` (kept as a built-in — see §7) |
| `custom` with non-empty text | a user prompt named "My prompt", `from: null`, made active |
| `custom` with empty text | `activePromptId = 'tour'` |

Runs once, guarded by a flag, in both windows — same shape as
`migrateModelSetting()`. The legacy keys are **not deleted**: a rider who downgrades
to v0.4.x still needs them.

---

## 3. Server: `GET /v1/prompts`

```http
GET /v1/prompts
If-None-Match: "7"
```

```jsonc
{
  "object": "list",
  "revision": 7,          // bumps on ANY change to any prompt
  "default": "tour",
  "data": [
    { "id": "tour", "version": 3, "label": "…", "description": "…",
      "systemPrompt": "…", "userPromptTemplate": "…",
      "changelog": "Tighter rules on how numbers are spoken." }
  ]
}
```

- `ETag: "7"`, and **304** on a match. A weekly check then costs one conditional GET.
  **Shipped differently:** `revision` is an FNV-1a hash of the table's own content, not
  a counter someone bumps. A counter is one more thing to forget in a repo that has
  already been bitten once by "remember to keep these in step" — and forgetting it here
  means every mod in the world keeps serving the old text with no error anywhere.
- Unauthenticated. This is public product copy, not user data, and requiring a token
  would mean BYOK riders had to connect to a service they chose not to use.
- **`/v1/styles` stays**, unchanged, forever. v0.4.x clients in the wild call it. It
  becomes a projection of the same table — id/label/description only.
- `styles.mjs` gains `userPromptTemplate` and `version` per style. It is already the
  one place a voice is defined server-side; it becomes the one place, period.

`revision` vs per-prompt `version`: `revision` is the cheap "has anything changed"
check; `version` is what a rider sees and what provenance compares against. Both, not
one.

---

## 4. Client: the update check

**When.** Once on settings-window open, and at most once per 24h, recorded in
`fetchedAt`. Never on overlay boot: the overlay fires commentary within a second of
real ride data, and a prompt fetch must not sit in front of that. The overlay reads
the cache and nothing else.

**Ordering.** Cached-then-refresh, always. The dropdown renders from cache
immediately; a fetch that lands later re-renders. A hung or refused fetch is a no-op,
not an error toast.

**Offline and first-run.** The bundled `BUILTIN_PROMPTS` in `announcer.mjs` remain the
floor. `builtinPrompts` cache empty or unreachable → the bundled set is used. The mod
must be fully functional with the service unreachable forever; that is already true
of every other BYOK path and this must not be the exception.

**Adopt rules.**

| situation | behaviour |
|---|---|
| built-in improved, rider is on it | adopt silently; note it in the Prompts tab |
| built-in improved, rider has a *copy* of it | **never touch the copy.** Show "the source has moved on" with a diff link |
| new built-in appears | appears in the dropdown; noted as new |
| built-in removed server-side | keep serving from cache; hide from the "new prompt" list |
| rider is on a built-in that disappears | keep using the cached text, say so once |

That "never touch the copy" row is the one that matters. A rider who edited a prompt
owns it; a server push that silently rewrote their words would be the worst thing this
feature could do.

**The notice.** A single dismissible line at the top of the Prompts tab —
*"Two voices were updated and one is new. See what changed."* Not a modal, not a toast
over a race. The overlay says nothing at all.

---

## 5. Client: the Prompts tab

```
┌ Commentary Style ──────────────────────────────────────────┐
│ ⓘ Two voices updated, one new.  What changed  ·  Dismiss   │
│                                                             │
│ Voice:  [ Built-in ▸ Tour de France            ▾ ]         │
│         The classic television booth. Measured…             │
│                                                             │
│         [ Duplicate & edit ]  [ New from blank ]            │
│                                                             │
│ ▾ View this prompt                        (read-only)       │
│   System message   ┌───────────────────────────────┐        │
│   User template    └───────────────────────────────┘        │
└─────────────────────────────────────────────────────────────┘
```

Selecting one of the rider's own swaps the buttons to
**Rename · Delete · Reset to source** and unlocks both textareas with a **Save**.

- The `<select>` is grouped — `Built-in` / `Your prompts` — via `<optgroup>`.
- **Duplicate & edit** is the primary path to authorship. It copies text and stamps
  `from: {id, version}`, so "reset to source" and "the source has moved on" both work.
- **New from blank** starts empty with the placeholder help visible. `from: null`.
- **Delete** on the active prompt falls back to `default` from the server payload.
- The existing placeholder help (`{riders}`, `{watching}`, `{raceContext}`, `{events}`,
  `{recentLines}`) moves under the user template and stays.
- Built-in textareas are `readonly`, not `disabled` — a rider must be able to select
  and copy the text.

**Per-provider honesty.** The tab must say, in the tab, which provider actually uses
what:

| provider | system message | user template |
|---|---|---|
| Anthropic / OpenAI-compatible | yours | yours |
| Lunatic hosted (free) | **the service's** — yours is discarded | yours |

Today this is buried in two help paragraphs on other tabs. It belongs here, next to
the editor, as a line that changes with the selected provider. `canUseCustomPrompt`
already exists in `auth.mjs` for when paid accounts lift the restriction.

---

## 6. Phoning home

A BYOK rider who never connects to the hosted service would, under this plan, start
making a periodic request to a Railway host. That deserves to be a decision, not a
side effect.

- **`promptUpdates` setting**, on the Prompts tab: *Check for improved voices* —
  `auto` (default) / `off`.
- The request carries **no device token, no account, no athlete id, no query string**.
  A bare conditional GET.
- It is disclosed in the Help tab and in one line under the setting.
- `off` means the bundled prompts, forever, with no degradation of anything else.

Default-on is defensible: it is the only way an existing install ever improves, the
request is anonymous, and it is one call a day. But it must be visible and one click
from off.

---

## 7. Reconcile the divergence first

Nothing above works while the two sets disagree. Step one, before any of it:

1. **One canonical set**, defined in `service/src/styles.mjs`, with
   `userPromptTemplate` and `version` on each: `tour`, `lunatic`, `domestique`,
   `tactical`.
2. **Mirror it into `pages/src/announcer.mjs` as `BUILTIN_PROMPTS`** — the bundled
   floor and the offline fallback.
3. **A CI check that the two agree.** The current comment asking a human to keep them
   in sync has already failed once; a test is what actually holds. `scripts/`
   compares the two files' prompt tables and fails on drift.

That last item is worth more than it looks. It is the same class of problem as the
settings window nobody executed: a promise in a comment with nothing enforcing it.

**Shipped in v0.5.0**, with one addition the plan did not anticipate: reconciling the
id spaces made `stylePreset` and `hostedStyle` name the same voices, so two settings
over one id space could now only disagree *silently* — worse than the honest
duplication before it. They are unified onto `stylePreset`, the hosted picker is gone,
and a hosted-only choice migrates across unless the shared key was set deliberately.

---

## 8. Phasing

| phase | ships | value on its own |
|---|---|---|
| **1. Reconcile** ✅ *done, v0.5.0* | one canonical set, `userPromptTemplate` + `version` server-side, mirrored bundle, drift check in CI | Lunatic and Old Pro became reachable on BYOK — the biggest single win, and no new machinery |
| **2. Library** ✅ *done, v0.6.0* | `promptLibrary`, migration, the redesigned Prompts tab, duplicate/edit/create/rename/delete, per-provider honesty | the whole second feature, entirely offline |
| **3. Fetch** ✅ *done, v0.7.0* | `GET /v1/prompts` + ETag, the 24h check, cache, adopt rules, `promptUpdates` setting | improved voices reach existing installs |
| **4. Polish** ✅ *done, v0.8.0* | "what changed" diff view, "the source has moved on" prompt, new-voice badge | makes phase 3 legible instead of mysterious |

Phases 1 and 2 are independent of the service being up. Phase 3 is the only one that
needs a deploy. Each is releasable.

**All four shipped.** One thing phase 4 needed that the plan did not anticipate: a diff
has to have a left-hand side, and phase 3's cache overwrote the old text. The cache now
retains the previous copy of *only the voices that changed*, carried forward across
successive checks until the notice is dismissed — so two updates a day apart still diff
against what the rider last read, not against the intermediate text they never saw.

---

## 9. Testing

The boot tests are the place for this — they already stub `fetch` and drive
`settingsStore` for real.

- `settings-boot-test.mjs`: the library round-trips (duplicate → edit → save →
  reselect), the migration table in §2 lands on the right `activePromptId`, delete
  falls back, caps are enforced with a message.
- `overlay-boot-test.mjs`: `buildPrompts()` picks the active prompt; an unreachable
  service leaves commentary working on bundled text.
- A new `scripts/prompt-parity-test.mjs` for the §7 drift check, run by CI.
- Service-side: `/v1/prompts` shape, `304` on a matching ETag, `/v1/styles` still
  returning exactly what v0.4.x expects.

---

## 10. Three calls that are yours

1. **Service as source of truth for built-ins?** Recommended yes — it is the only
   mechanism that reaches installed zips. The alternative is that voices improve only
   at release, which is where we are now.
2. **`promptUpdates` default.** Recommended `auto`, given the request is anonymous and
   daily. `off` by default would mean almost nobody ever gets an improved voice.
3. **Do the rider's own prompts sync to their Discord account?** Recommended **no, not
   yet.** It needs storage, a size policy, and a moderation answer for text the server
   would then hold. Local-only is the honest scope for now, and syncing is a natural
   paid-account feature later.
