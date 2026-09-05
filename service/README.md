# Lunatic Announcer — hosted commentary service

A small Node service that stands between the Sauce mod and a model provider, so
a new user can hear race commentary without first creating an Anthropic account
and pasting an API key.

It speaks the **OpenAI chat-completions API**. That is the whole design
decision: the mod already has an "OpenAI-compatible" provider adapter, so
pointing it here is a base URL and a token — no new client code path, and the
upstream model can change without shipping a new mod.

## Status

Free tier. Three model aliases, three announcer voices, no custom prompting.
**Sign in with Discord** works and issues a durable key with a larger
allowance. Paid licences are not built yet; the `tier` field on an account and
`canUseCustomPrompt` are the seams they attach to.

## Deploy to Railway

1. Point a Railway service at this repository with **root directory
   `service`**. Nixpacks detects Node and runs `npm start`.
2. Add the **Redis** plugin. It injects `REDIS_URL`, and without it quotas and
   the spend breaker live in process memory and reset on every deploy.
3. Set variables from [`.env.example`](.env.example). At minimum: `FAST_API_KEY`,
   `TOKEN_SECRET`, `DAILY_BUDGET_USD`.
4. Verify the deploy:

   ```bash
   node scripts/smoke.mjs https://your-app.up.railway.app          # free
   node scripts/smoke.mjs https://your-app.up.railway.app --live   # + one real call
   ```

   It checks health, the model and voice lists, token minting, that
   unauthenticated calls are rejected, and the prompt-size cap. `--live` adds
   one real commentary call — a fraction of a cent — and reports time to first
   token, which is the number that actually determines whether the spoken
   commentary feels right. It exits non-zero on failure, so it can gate a
   deploy, and it warns loudly about the two mistakes a fresh deploy makes:
   no Redis, and fewer than three models configured.

## Endpoints

| | |
|---|---|
| `POST /v1/device` | Mint an anonymous device token. Called once, stored in mod settings. |
| `POST /v1/pair/start` | Begin a Discord sign-in. Returns a public `code`, a secret `pollToken`, and the URL to open. |
| `POST /v1/pair/poll` | Collect the key once the browser sign-in completes. Single use. |
| `GET /auth/discord/start` | Redirects to Discord. This is the URL the mod opens in a browser. |
| `GET /auth/discord/callback` | Discord's redirect target. Creates or finds the account and shows the key. |
| `GET /v1/models` | The aliases that are actually usable (model id **and** key present). |
| `GET /v1/styles` | The announcer voices this service provides (id, label, description). |
| `GET /v1/prompts` | Those voices in full, for a client that builds its own request. ETag + 304. |
| `GET /v1/quota` | Remaining allowance, without spending a call. |
| `POST /v1/chat/completions` | The commentary call. SSE unless `stream: false`. |
| `GET /healthz` | Liveness, storage durability, today's spend, configured models. |
| `GET /` (and `/help`) | The public help page: install steps, provider setup, troubleshooting. |

The help page is rendered from this service's own configuration — the voices from
`styles.mjs`, the models from `availableAliases()`, the monthly allowances from
`config.mjs` — so its numbers cannot drift from what the API actually does. It
prints the URL riders should paste into the mod, taken from `PUBLIC_URL` or
`DISCORD_REDIRECT_URI`; with neither set it shows a placeholder and the smoke
test warns.

Auth is `Authorization: Bearer <device token>`. Send `X-Lunatic-Athlete: <zwift
id>` when you have it — see *Identity* below.

```bash
TOKEN=$(curl -sX POST $URL/v1/device | jq -r .token)
curl -N -X POST $URL/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"model":"free-fast","style":"lunatic",
       "messages":[{"role":"user","content":"EVENTS: Vermeulen attacks."}]}'
```

## How "no custom prompting" is enforced

The service speaks a standard API, so a client can put anything in a system
message. On the free tier **that system message is discarded** and one of the
voices in `styles.mjs` is used instead. The user message — the rendered race
data — passes through, because that is the payload the feature needs.

One honest gap: a determined user could smuggle instructions into the *user*
message, since the mod lets them edit their user template. That is not worth
engineering against. What it buys them is a single sentence from a cheap model
under a hard output cap and a monthly quota. **The limits, not the prompt swap,
are what bound the cost.** The prompt swap is what keeps the product coherent
and makes a paid tier worth buying.

## Model aliases

Clients ask for `free-fast`, `free-balanced` or `free-colour`. The service maps
each to a real provider and model. Nothing client-side ever names an upstream
model, so you can swap or reprice one without a mod release — which matters,
because a Sauce mod updates only when a user downloads a new zip.

An alias missing a model id or an API key is not offered at all. A partly
configured deployment therefore serves fewer models rather than producing 404s
its users cannot diagnose.

## Identity

A device token is an HMAC-signed opaque string minted on first run. It
identifies a device, not a person, and it is **trivially farmable** — clear
storage, get a new one. That is understood and accepted. It exists to attribute
honest traffic; the global spend breaker is what actually bounds abuse.

Quota buckets prefer the **Zwift athlete id** when the client sends one, because
it survives a storage wipe. It is not a secret and anyone can claim any value,
so it is used only as a rate-limit bucket, never as proof of identity.

## Sign in with Discord

An account is created by signing in and holds a long-lived key the mod sends as
a bearer token — the same header an anonymous device token uses, so nothing
downstream of `auth.mjs` branches on which it got.

**Why a rider would bother:** the key survives a reinstall or a cleared settings
bag (sign in again anywhere and you get the *same* key back), the monthly
allowance is larger, and it is what a paid tier will attach to. For the
operator it is a real, de-duplicated user count and an identity that cannot be
reset by clearing storage.

**Re-signing in returns the existing key.** Minting a new one per login would
silently reset the user's quota and hand a fresh allowance to anyone who logs
out and back in — exactly what accounts are meant to prevent.

**The pairing flow.** The overlay cannot receive an OAuth redirect, and copying
a long key out of a browser is the friction the hosted tier exists to remove.
So: the mod calls `/v1/pair/start` for a public `code` and a secret
`pollToken`, opens `/auth/discord/start?code=…` in the browser, and polls. The
two values are separate on purpose — the code travels through a redirect chain
and is treated as public; the poll token never leaves the mod, so only the
client that began the flow can collect the key. The success page still shows
the key in full, so a rider whose poll failed can finish by hand.

**Sign-in refuses without durable storage.** Losing a quota counter on redeploy
is annoying; losing an account means a rider's key stops working with no
recourse. `/healthz` reports `accounts: ready`, `not-configured`, or
`blocked-no-durable-storage`.

## Cost controls

Ordered by how much they matter:

1. **`DAILY_BUDGET_USD`** — the global breaker. Per-user quotas do not bound the
   bill; a thousand users each behaving normally still costs a thousand users'
   worth. When the day's spend crosses this, free calls are refused with a
   message telling riders to add their own key, which the mod fully supports.
2. **`MAX_OUTPUT_TOKENS`** — clamps whatever the client asks for.
3. **`MAX_PROMPT_CHARS`** — a real payload is ~4KB; this is what stops the
   endpoint being a general-purpose LLM proxy.
4. **`FREE_CALLS_PER_MONTH`** and the burst window — per-identity fairness.

Calls are counted **before** the upstream request, not after. An abandoned or
failed stream still consumed tokens, and counting only successes would make a
retry loop free.

At roughly 1,000 input and 60 output tokens per call, a call costs about
$0.0013 and a racing hour $0.10–0.39. 150 calls/month is about one racing hour,
or ~$0.20 per user — so 1,000 active free users is roughly $195/month. Size
`DAILY_BUDGET_USD` against what you are willing to lose, not against demand.

## Verifying a deploy

`scripts/smoke.mjs` is the fastest way to tell a working deployment from a
half-configured one. The two warnings worth acting on:

- **`durable storage — IN-MEMORY`.** Quotas and the spend breaker reset on every
  deploy. Add the Redis plugin.
- **`only N configured`.** An alias needs both a model id and an API key, or it
  is silently not offered.

## Local development

```bash
cd service
FAST_API_KEY=sk-ant-... TOKEN_SECRET=dev npm start
```

No `npm install` is needed for the default path: `redis` is imported lazily and
only when `REDIS_URL` is set.

## Not done yet

- **Paid licences.** An account already carries a `tier`, and `paid` unlocks
  `canUseCustomPrompt` in `auth.mjs`. Nothing sells or grants it yet.
- **A verified run inside Sauce.** The client wiring is done — the mod has a
  `hosted` provider with a Connect button, model and voice pickers filled from
  `/v1/models` and `/v1/styles`, and a quota readout — and it has been driven
  end to end against this service from Node. It has not yet run inside a real
  Sauce overlay.
- **A durable-storage guard.** The service will start and serve happily with
  in-memory counters; it warns in `/healthz` but does not refuse.
