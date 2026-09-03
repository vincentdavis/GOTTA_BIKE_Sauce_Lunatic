/**
 * Model providers for the Lunatic Announcer.
 *
 * This is a LEAF module: it imports nothing, from the app or from Sauce. Two
 * things depend on that. `announcer.mjs` runs `settingsStore.setDefault()` and
 * `migrateLegacySettings()` at module load, so a cycle back into it would hit
 * the temporal dead zone. And keeping it dependency-free means the adapters can
 * be reasoned about (and, later, tested) without a Sauce window.
 *
 * An adapter is three pure functions and a description of its models:
 *
 *   buildRequest(opts)  -> {url, headers, body}   everything fetch needs
 *   parseHttpError(...) -> {message, retryAfter, retryable}
 *   readEvent(parsed)   -> {text?, inputTokens?, outputTokens?, error?} | null
 *
 * THE HEADER RULE: buildRequest returns the COMPLETE header set and the shell
 * passes it through verbatim. Never merge a shared base object with per-provider
 * extras. Google rejects a CORS preflight that requests any header it does not
 * allow, so a base object still carrying Anthropic's `x-api-key` fails every
 * Google request at preflight -- with no response body to parse and only a
 * generic network error to show the user.
 *
 * THE USAGE RULE: readEvent returns ABSOLUTE token counts, never increments,
 * and the shell does last-write-wins. That single contract absorbs three
 * incompatible usage models: Anthropic splits input across `message_start` and
 * output across `message_delta`, OpenAI sends both once in a final chunk, and
 * Gemini re-sends cumulative totals on every chunk.
 */

export const DEFAULT_PROVIDER = 'anthropic';

// Leading slash: global across the Sauce origin, so the overlay and the
// settings window share one device token rather than minting two.
export const DEVICE_TOKEN_KEY = '/gotta-bike-lunatic-device-token';
export const QUOTA_KEY = '/gotta-bike-lunatic-quota';

// With thinking disabled, Opus 5 occasionally leaks `<thinking>` tags into the
// visible text. One line of system prompt is cheaper than stripping them out.
const NO_INTERNAL_TAGS = 'Do not include internal or system XML tags in your response.';

// ============================================================================
// Anthropic
// ============================================================================

// Costs are USD per 1000 tokens. Anthropic publishes per 1M -- divide by 1000
// when updating these, or every figure in the overlay is 1000x wrong.
//
// `thinkingOff` marks a model that runs ADAPTIVE thinking when the `thinking`
// key is omitted. Thinking tokens bill against max_tokens, which is 60 here, so
// the whole budget goes into the thinking block and the stream ends empty.
const ANTHROPIC_MODELS = {
    'claude-haiku-4-5-20251001': { label: 'Claude Haiku 4.5 (fastest, cheapest — best for live)', input: 0.001, output: 0.005 },
    'claude-sonnet-5': { label: 'Claude Sonnet 5 (balanced)', input: 0.002, output: 0.010, thinkingOff: true },
    'claude-opus-5': { label: 'Claude Opus 5 (most capable, slowest)', input: 0.005, output: 0.025, thinkingOff: true }
};

const anthropic = {
    id: 'anthropic',
    label: 'Anthropic',
    keySetting: 'claudeApiKey',
    modelSetting: 'claudeModel',
    defaultModel: 'claude-haiku-4-5-20251001',
    models: ANTHROPIC_MODELS,

    isConfigured: get => !!get('claudeApiKey'),

    buildRequest({ model, apiKey, systemPrompt, userPrompt, maxTokens }) {
        const thinkingOff = !!ANTHROPIC_MODELS[model]?.thinkingOff;
        return {
            url: 'https://api.anthropic.com/v1/messages',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'anthropic-dangerous-direct-browser-access': 'true'
            },
            body: {
                model,
                max_tokens: maxTokens,
                system: thinkingOff ? `${systemPrompt}\n\n${NO_INTERNAL_TAGS}` : systemPrompt,
                ...(thinkingOff ? { thinking: { type: 'disabled' } } : {}),
                messages: [{ role: 'user', content: userPrompt }],
                stream: true
            }
        };
    },

    parseHttpError(status, body, headers) {
        return {
            message: body?.error?.message || `API error: ${status}`,
            retryAfter: Number(headers.get('retry-after')) || null,
            retryable: status === 429 || status >= 500
        };
    },

    readEvent(p) {
        // Anthropic streams mid-stream failures as an error event after a 200.
        if (p.type === 'error') {
            return {
                error: {
                    message: p.error?.message || p.error?.type || 'Streaming error',
                    retryable: p.error?.type === 'overloaded_error'
                }
            };
        }
        if (p.type === 'content_block_delta' && p.delta?.text) return { text: p.delta.text };
        if (p.type === 'message_start' && p.message?.usage) {
            return { inputTokens: p.message.usage.input_tokens || 0 };
        }
        if (p.type === 'message_delta' && p.usage) {
            return { outputTokens: p.usage.output_tokens || 0 };
        }
        return null;
    }
};

// ============================================================================
// OpenAI-compatible — one adapter, many services
// ============================================================================

/**
 * Presets only prefill the base URL and a suggested model. The model itself is
 * free text, deliberately: model IDs churn faster than this mod ships, and a
 * hard-coded dropdown that has gone stale produces a 404 on every request. The
 * user can always paste whatever their provider currently offers.
 */
export const COMPATIBLE_PRESETS = {
    openai: {
        label: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        // Newer OpenAI models reject `max_tokens` and require this instead.
        maxTokensParam: 'max_completion_tokens',
        hint: 'Reasoning models (o-series and similar) cannot suppress reasoning tokens, ' +
              'which bill against the output cap — at 60 tokens they return nothing. Use a chat model.'
    },
    gemini: {
        label: 'Google Gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        // UNVERIFIED: Gemini thinks by default and thinking bills against the
        // output cap, so it must be suppressed or the stream comes back empty
        // at maxTokens 60. `reasoning_effort` is the documented OpenAI-compat
        // spelling, but this has NOT been confirmed against a live key. If
        // Gemini returns empty responses, this is the first thing to check.
        extraBody: { reasoning_effort: 'none' },
        hint: 'Gemini 2.5 Pro cannot disable thinking (floor is 128 tokens) and will return ' +
              'nothing at this output cap. Use a Flash-class model.'
    },
    openrouter: {
        label: 'OpenRouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        hint: 'Fronts many providers behind one key. Model IDs look like "vendor/model".'
    },
    groq: {
        label: 'Groq',
        baseUrl: 'https://api.groq.com/openai/v1',
        hint: 'Lowest time-to-first-token, which is what the spoken commentary actually needs.'
    },
    ollama: {
        label: 'Ollama (local)',
        baseUrl: 'http://localhost:11434/v1',
        keyOptional: true,
        hint: 'Runs on your machine. No API key and no cost, but the overlay competes with Zwift for GPU.'
    },
    custom: {
        label: 'Custom…',
        baseUrl: '',
        hint: 'Any endpoint that speaks the OpenAI chat-completions API with SSE streaming.'
    }
};

export function presetFor(id) {
    return COMPATIBLE_PRESETS[id] || COMPATIBLE_PRESETS.openai;
}

const compatible = {
    id: 'compatible',
    label: 'OpenAI-compatible',
    keySetting: 'compatApiKey',
    modelSetting: 'compatModel',
    baseUrlSetting: 'compatBaseUrl',
    defaultModel: '',
    // No price table: the model is free text, so pricing comes from the user's
    // own optional per-1M figures (see costFor).
    models: null,

    isConfigured: get => !!(String(get('compatModel') || '').trim() && String(get('compatBaseUrl') || '').trim()),

    buildRequest({ model, apiKey, systemPrompt, userPrompt, maxTokens, baseUrl, preset }) {
        const root = String(baseUrl || '').trim().replace(/\/+$/, '');
        const cfg = presetFor(preset);

        // Complete header set, never merged with a shared base (see file header).
        const headers = { 'Content-Type': 'application/json' };
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

        // Most compatible servers only know `max_tokens`; current OpenAI models
        // only accept `max_completion_tokens`. Send exactly one.
        const tokenParam = cfg.maxTokensParam || 'max_tokens';

        return {
            url: `${root}/chat/completions`,
            headers,
            body: {
                model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                [tokenParam]: maxTokens,
                stream: true,
                // Without this, no usage is reported at all and the cost readout
                // sits at $0.0000 forever with nothing logged anywhere.
                stream_options: { include_usage: true },
                ...(cfg.extraBody || {})
            }
        };
    },

    parseHttpError(status, body, headers) {
        const type = body?.error?.type || body?.error?.code || '';
        // A dead key returns 429 exactly like a rate limit, but retrying it just
        // burns ten seconds and fails identically.
        const deadKey = type === 'insufficient_quota' || type === 'invalid_api_key';
        return {
            message: body?.error?.message || `API error: ${status}`,
            retryAfter: Number(headers.get('retry-after')) || null,
            retryable: !deadKey && (status === 429 || status >= 500)
        };
    },

    readEvent(p) {
        // OpenAI-shaped mid-stream failures put `error` at the TOP level, with
        // no discriminator — nothing like Anthropic's {type:'error'}.
        if (p.error) {
            return {
                error: {
                    message: p.error.message || p.error.type || 'Streaming error',
                    retryable: true
                }
            };
        }
        // The usage chunk carries `choices: []`, so this must stay optional.
        const text = p.choices?.[0]?.delta?.content;
        if (text) return { text };
        if (p.usage) {
            return {
                inputTokens: p.usage.prompt_tokens || 0,
                outputTokens: p.usage.completion_tokens || 0
            };
        }
        return null;
    },

    // Checked as a raw string before JSON.parse — it is not JSON.
    doneSentinel: '[DONE]'
};

/**
 * The Lunatic hosted service.
 *
 * Deliberately a thin skin over the OpenAI-compatible adapter: the service
 * speaks that API precisely so there is no fourth streaming code path here.
 * What differs is onboarding, not protocol —
 *
 *   - no API key to paste. A device token is minted once from /v1/device and
 *     kept in a GLOBAL settings key so both windows see the same one.
 *   - the model is an ALIAS (free-fast, …) resolved server-side, so upstream
 *     models can change without a new mod release.
 *   - the announcer voice is chosen by `style` and rendered server-side. The
 *     free tier ignores any system prompt we send, so we do not send one.
 *   - the Zwift athlete id rides along as a rate-limit bucket that survives a
 *     storage wipe. It is not a secret and the service treats it as a bucket
 *     key only, never as proof of identity.
 */
const hosted = {
    id: 'hosted',
    label: 'Lunatic (hosted)',
    keySetting: DEVICE_TOKEN_KEY,
    modelSetting: 'hostedModel',
    baseUrlSetting: 'hostedBaseUrl',
    defaultModel: 'free-fast',
    models: null,   // aliases are discovered from the service, and are free

    isConfigured: get => !!(String(get('hostedBaseUrl') || '').trim() &&
                            String(get(DEVICE_TOKEN_KEY) || '').trim()),

    buildRequest({ model, apiKey, systemPrompt, userPrompt, maxTokens, baseUrl, extra = {} }) {
        const root = String(baseUrl || '').trim().replace(/\/+$/, '');
        const headers = {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`
        };
        // Only send it when we actually have one — an empty header is worse
        // than none, since the service would bucket everyone under the same key.
        if (extra.athleteId) headers['X-Lunatic-Athlete'] = String(extra.athleteId);

        return {
            url: `${root}/v1/chat/completions`,
            headers,
            body: {
                model: model || 'free-fast',
                style: extra.style || undefined,
                // The system prompt is discarded server-side on the free tier.
                // Sending the local one anyway would just inflate the payload
                // against the service's prompt-size cap for no effect.
                messages: [{ role: 'user', content: userPrompt }],
                max_tokens: maxTokens,
                stream: true
            }
        };
    },

    parseHttpError(status, body, headers) {
        const code = body?.error?.code || '';
        // Quota and budget refusals are the service working as designed, not
        // transient failures — retrying spends the rider's remaining calls on
        // an answer that cannot change.
        const permanent = code === 'quota_exhausted' ||
                          code === 'daily_budget_exhausted' ||
                          code === 'invalid_token' ||
                          code === 'prompt_too_large';
        return {
            message: body?.error?.message || `Service error: ${status}`,
            retryAfter: Number(headers.get('retry-after')) || null,
            retryable: !permanent && (status === 429 || status >= 500)
        };
    },

    readEvent: p => compatible.readEvent(p),
    doneSentinel: '[DONE]'
};

export const PROVIDERS = { anthropic, compatible, hosted };

export function providerFor(id) {
    return PROVIDERS[id] || PROVIDERS[DEFAULT_PROVIDER];
}

/**
 * Cost in USD for one call, or {known:false} when we have no basis to guess.
 *
 * There is deliberately no fall back to another model's pricing: quoting a
 * local Ollama run at Haiku rates is worse than admitting ignorance, and the
 * old fallback did exactly that for any unrecognised model.
 */
export function costFor({ providerId, model, inputTokens, outputTokens, userInputPer1M, userOutputPer1M }) {
    const p = providerFor(providerId);

    const entry = p.models?.[model];
    if (entry) {
        return { cost: (inputTokens / 1000) * entry.input + (outputTokens / 1000) * entry.output, known: true };
    }

    // Free-text models can still be costed if the user supplied the rates.
    const inPer1M = Number(userInputPer1M);
    const outPer1M = Number(userOutputPer1M);
    if (inPer1M > 0 || outPer1M > 0) {
        return {
            cost: (inputTokens / 1e6) * (inPer1M || 0) + (outputTokens / 1e6) * (outPer1M || 0),
            known: true
        };
    }

    return { cost: 0, known: false };
}

// ============================================================================
// The streaming shell — provider-agnostic
// ============================================================================

/**
 * Run one completion, streaming text to `onText` as it arrives.
 *
 * Everything here is deliberately provider-blind: SSE framing, the stall
 * watchdog, abort handling and the retry are identical for every provider, and
 * only the three adapter functions know any protocol.
 *
 * @param onText      (chunk, fullTextSoFar) for each text delta
 * @param onController called with each attempt's AbortController, so the caller
 *                    can abort a stuck stream; called again per retry
 * @param onSettled   called with the controller when an attempt finishes
 */
export async function streamCompletion({
    provider, model, apiKey, baseUrl, preset, extra,
    systemPrompt, userPrompt, maxTokens,
    onText, onController, onSettled, onResponse
}) {
    const adapter = providerFor(provider);

    // One attempt = one AbortController (an aborted controller can't be reused).
    async function attempt() {
        const ctrl = new AbortController();
        onController?.(ctrl);

        let stallTimer = null;
        // Stall timeout, not a total timeout: a slow-but-progressing stream is
        // never killed, but a dead socket can't hang the caller forever.
        const bump = ms => {
            clearTimeout(stallTimer);
            stallTimer = setTimeout(() => ctrl.abort(), ms);
        };

        let fullResponse = '';
        let inputTokens = 0;
        let outputTokens = 0;

        try {
            bump(15000); // headers / TTFT window

            const req = adapter.buildRequest({
                model, apiKey, systemPrompt, userPrompt, maxTokens, baseUrl, preset, extra
            });

            const response = await fetch(req.url, {
                method: 'POST',
                signal: ctrl.signal,
                headers: req.headers,   // verbatim — see THE HEADER RULE
                body: JSON.stringify(req.body)
            });

            // Response headers carry the hosted tier's remaining quota, which
            // the overlay shows in place of a dollar figure.
            onResponse?.(response);

            if (!response.ok) {
                const body = await response.json().catch(() => ({}));
                const info = adapter.parseHttpError(response.status, body, response.headers);
                const err = new Error(info.message);
                err.status = response.status;
                err.retryAfter = info.retryAfter;
                err.retryable = info.retryable;
                throw err;
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                bump(8000);
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                // CRLF-tolerant: Google's frames arrive CRLF-terminated, which
                // would otherwise leave the sentinel comparing as '[DONE]\r'.
                const lines = buffer.split(/\r?\n/);
                buffer = lines.pop() || '';

                for (const line of lines) {
                    // The space after `data:` is optional in the SSE spec, and
                    // several local servers omit it.
                    const m = /^data:[ \t]?/.exec(line);
                    if (!m) continue;
                    const raw = line.slice(m[0].length);

                    if (adapter.doneSentinel && raw === adapter.doneSentinel) continue;

                    let parsed;
                    try {
                        parsed = JSON.parse(raw);
                    } catch (e) {
                        continue; // incomplete/non-JSON chunk
                    }

                    const ev = adapter.readEvent(parsed);
                    if (!ev) continue;

                    if (ev.error) {
                        const err = new Error(ev.error.message);
                        err.midStream = true;
                        err.retryable = !!ev.error.retryable;
                        throw err;
                    }
                    if (ev.text) {
                        fullResponse += ev.text;
                        onText?.(ev.text, fullResponse);
                    }
                    // Absolute, not incremental — see THE USAGE RULE.
                    if (ev.inputTokens != null) inputTokens = ev.inputTokens;
                    if (ev.outputTokens != null) outputTokens = ev.outputTokens;
                }
            }

            if (!fullResponse.trim()) {
                // Naming the provider matters: the commonest cause is a model
                // that spent the whole output budget on reasoning tokens.
                throw new Error(`Empty response from ${adapter.label} — the model may be ` +
                                `spending the output budget on reasoning. Try another model.`);
            }

            return { text: fullResponse, inputTokens, outputTokens };

        } finally {
            clearTimeout(stallTimer);
            onSettled?.(ctrl);
        }
    }

    try {
        return await attempt();
    } catch (err) {
        // Retry once on transient failures. An aborted request is never retried
        // -- it was aborted deliberately, by the stall watchdog or by the user.
        const transient = err.retryable ?? (err.status === 429 || err.status >= 500);
        const retryable = transient && !String(err.name || '').includes('Abort');
        if (!retryable) {
            console.error('[Lunatic] provider error:', err);
            throw err;
        }
        const waitMs = Math.min((err.retryAfter || 1) * 1000, 10000);
        console.warn(`[Lunatic] transient API error, retrying in ${waitMs}ms:`, err.message);
        await new Promise(r => setTimeout(r, waitMs));
        return await attempt();
    }
}
