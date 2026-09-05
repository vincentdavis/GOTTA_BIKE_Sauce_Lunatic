/**
 * Lunatic Announcer hosted commentary service.
 *
 * Speaks the OpenAI chat-completions API on purpose. The mod already has an
 * "OpenAI-compatible" provider adapter, so pointing it at this service is a
 * base URL and a token -- no new client code path, and the upstream model can
 * change without shipping a new mod.
 *
 *   POST /v1/device            mint an anonymous device token
 *   GET  /v1/models            the free model aliases that are actually usable
 *   GET  /v1/styles            the announcer voices this service provides
 *   GET  /v1/prompts           those voices in full, for clients that build
 *                              their own request (ETag + 304)
 *   GET  /v1/quota             remaining allowance, without spending a call
 *   POST /v1/chat/completions  the commentary call (SSE by default)
 *   GET  /                     the public help page (also /help)
 *   GET  /healthz              liveness plus the two facts an operator needs
 */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

import {
    PORT, ALLOWED_ORIGIN, DEFAULT_ALIAS, MAX_OUTPUT_TOKENS, MAX_PROMPT_CHARS,
    DAILY_BUDGET_USD, availableAliases, resolveAlias, hasAccounts, publicUrl
} from './config.mjs';
import { identify, mintDeviceToken } from './auth.mjs';
import { initStorage, storageIsDurable } from './store.mjs';
import { admit, quotaFor, recordSpend, spentToday } from './quota.mjs';
import {
    startPairing, pollPairing, discordAuthorizeUrl, handleDiscordCallback,
    successPage, errorPage
} from './discord.mjs';
import { styleFor, listStyles, listPromptDefinitions, promptsRevision, DEFAULT_STYLE } from './styles.mjs';
import { helpPage } from './site.mjs';
import { callUpstream, UpstreamError } from './upstream.mjs';

const MAX_BODY_BYTES = 256 * 1024;

function accountsUnavailableReason() {
    if (!hasAccounts()) {
        return 'Discord sign-in is not configured on this service. ' +
               'The anonymous Connect button works without an account.';
    }
    return 'Discord sign-in is unavailable because this service has no durable storage. ' +
           'The anonymous Connect button works without an account.';
}

function corsHeaders() {
    return {
        'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
        'Access-Control-Allow-Headers': 'content-type, authorization, x-lunatic-athlete, if-none-match',
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
        // Without this the browser hides ETag from the page and every prompt
        // check re-downloads the table instead of getting a 304.
        'Access-Control-Expose-Headers': 'etag',
        'Access-Control-Max-Age': '86400'
    };
}

function json(res, status, payload, extraHeaders = {}) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...corsHeaders(),
        ...extraHeaders
    });
    res.end(body);
}

/** OpenAI-shaped error, so a generic client renders it sensibly. */
function apiError(res, status, message, code, extraHeaders = {}) {
    json(res, status, { error: { message, type: 'invalid_request_error', code } }, extraHeaders);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', c => {
            size += c.length;
            if (size > MAX_BODY_BYTES) {
                reject(Object.assign(new Error('Request body too large'), { status: 413 }));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => {
            if (!chunks.length) return resolve({});
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch {
                reject(Object.assign(new Error('Body is not valid JSON'), { status: 400 }));
            }
        });
        req.on('error', reject);
    });
}

// ---------------------------------------------------------------------------
// Chat completions
// ---------------------------------------------------------------------------

async function handleChat(req, res, body) {
    const ident = await identify(req);
    if (ident.kind === 'anonymous') {
        return apiError(res, 401,
            'Missing or invalid token. Call POST /v1/device once to get one.',
            'invalid_token');
    }

    const aliasId = String(body.model || DEFAULT_ALIAS);
    const alias = resolveAlias(aliasId);
    if (!alias) {
        const offered = availableAliases().map(a => a.id).join(', ') || '(none configured)';
        return apiError(res, 404,
            `Unknown model "${aliasId}". This service offers: ${offered}.`,
            'model_not_found');
    }

    const messages = Array.isArray(body.messages) ? body.messages : [];
    const totalChars = messages.reduce((n, m) => n + String(m?.content || '').length, 0);
    if (totalChars > MAX_PROMPT_CHARS) {
        return apiError(res, 413,
            `Prompt is ${totalChars} characters; the limit is ${MAX_PROMPT_CHARS}.`,
            'prompt_too_large');
    }

    const userPrompt = messages
        .filter(m => m?.role === 'user')
        .map(m => String(m.content || ''))
        .join('\n\n')
        .trim();

    if (!userPrompt) {
        return apiError(res, 400, 'No user message in the request.', 'empty_prompt');
    }

    // THE FREE-TIER RULE: the client's system message is discarded and this
    // service supplies the voice. See styles.mjs for why this is the
    // enforcement point and what it does and does not protect against.
    const style = styleFor(body.style || DEFAULT_STYLE);
    const clientSystem = messages.filter(m => m?.role === 'system')
        .map(m => String(m.content || '')).join('\n\n').trim();
    const systemPrompt = (ident.canUseCustomPrompt && clientSystem) ? clientSystem : style.systemPrompt;

    const asked = Number(body.max_tokens ?? body.max_completion_tokens ?? 60);
    const maxTokens = Math.min(Number.isFinite(asked) && asked > 0 ? asked : 60, MAX_OUTPUT_TOKENS);

    // Counted before the call, not after: an abandoned or failed stream still
    // burned upstream tokens.
    const gate = await admit(ident.bucket, ident.tier);
    if (!gate.ok) {
        const extra = gate.retryAfter ? { 'Retry-After': String(gate.retryAfter) } : {};
        return apiError(res, gate.status, gate.message, gate.code, extra);
    }

    const quotaHeaders = { 'X-Lunatic-Quota-Remaining': String(gate.remaining ?? '') };

    // Abort upstream the moment the client goes away -- a rider closing the
    // overlay mid-stream should not keep paying for tokens.
    const ac = new AbortController();
    res.on('close', () => ac.abort());

    const wantsStream = body.stream !== false;
    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);

    let started = false;
    let text = '';
    let usage = { inputTokens: 0, outputTokens: 0 };

    try {
        for await (const ev of callUpstream({ alias, systemPrompt, userPrompt, maxTokens, signal: ac.signal })) {
            if (ev.usage) {
                usage = ev.usage;
                continue;
            }
            if (!ev.text) continue;
            text += ev.text;

            if (!wantsStream) continue;

            if (!started) {
                started = true;
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream; charset=utf-8',
                    // no-transform stops any intermediary rewriting or
                    // buffering the stream; X-Accel-Buffering is the nginx
                    // spelling of the same request.
                    'Cache-Control': 'no-cache, no-transform',
                    'Connection': 'keep-alive',
                    'X-Accel-Buffering': 'no',
                    ...corsHeaders(),
                    ...quotaHeaders
                });
                res.flushHeaders?.();
                writeChunk(res, { id, created, model: aliasId, delta: { role: 'assistant', content: '' } });
            }
            writeChunk(res, { id, created, model: aliasId, delta: { content: ev.text } });
        }
    } catch (err) {
        if (ac.signal.aborted) return;   // client left; nothing to say

        const status = err instanceof UpstreamError ? err.status : 502;
        const message = err instanceof UpstreamError ? err.message : 'The commentary service failed.';
        if (!(err instanceof UpstreamError)) console.error('[chat] unexpected:', err);

        if (started) {
            // Headers are already out, so the only way to report this is inside
            // the stream. The mod reads a top-level `error` on a chunk.
            writeRaw(res, { error: { message, type: 'server_error' } });
            res.end();
        } else {
            apiError(res, status, message, 'upstream_error', quotaHeaders);
        }
        return;
    } finally {
        // Record spend even on failure: the tokens were still consumed.
        recordSpend(usage.inputTokens, usage.outputTokens).catch(e =>
            console.error('[chat] spend accounting failed:', e.message));
    }

    if (ac.signal.aborted) return;

    if (!wantsStream) {
        return json(res, 200, {
            id,
            object: 'chat.completion',
            created,
            model: aliasId,
            choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
            usage: {
                prompt_tokens: usage.inputTokens,
                completion_tokens: usage.outputTokens,
                total_tokens: usage.inputTokens + usage.outputTokens
            }
        }, quotaHeaders);
    }

    if (!started) {
        // The upstream produced nothing. Overwhelmingly this means the model
        // spent its whole output budget on reasoning tokens, so say that
        // rather than a bare "empty response".
        return apiError(res, 502,
            'The model returned no text. It may be spending the output budget on reasoning.',
            'empty_response', quotaHeaders);
    }

    writeChunk(res, { id, created, model: aliasId, delta: {}, finish: 'stop', usage });
    writeRaw(res, '[DONE]');
    res.end();
}

function writeChunk(res, { id, created, model, delta, finish = null, usage = null }) {
    const chunk = {
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finish }]
    };
    if (usage) {
        chunk.usage = {
            prompt_tokens: usage.inputTokens,
            completion_tokens: usage.outputTokens,
            total_tokens: usage.inputTokens + usage.outputTokens
        };
    }
    writeRaw(res, chunk);
}

function writeRaw(res, payload) {
    const s = typeof payload === 'string' ? payload : JSON.stringify(payload);
    res.write(`data: ${s}\n\n`);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders());
        return res.end();
    }

    try {
        /**
         * The public help page.
         *
         * The service URL is the one thing a rider types into the mod by hand,
         * so it is also the one they will paste into a browser -- and until now
         * that returned a JSON 404. Install steps, provider setup and
         * troubleshooting live here, rendered from this service's own config so
         * the numbers on it cannot go stale.
         */
        if ((req.method === 'GET' || req.method === 'HEAD') && (path === '/' || path === '/help')) {
            const body = helpPage();
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Content-Length': Buffer.byteLength(body),
                // Nothing on the page is per-user, but it is rendered from live
                // config, so a short cache rather than a long one.
                'Cache-Control': 'public, max-age=300',
                // The page loads nothing from anywhere: no scripts, no fonts,
                // no images beyond the inline SVG. Say so, so a future edit
                // that adds a third-party script fails loudly.
                'Content-Security-Policy':
                    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'",
                'X-Content-Type-Options': 'nosniff',
                'Referrer-Policy': 'no-referrer'
            });
            return res.end(req.method === 'HEAD' ? undefined : body);
        }

        if (req.method === 'GET' && path === '/healthz') {
            const spend = await spentToday();
            return json(res, 200, {
                ok: true,
                // Both of these are things an operator otherwise discovers from
                // a bill rather than from a dashboard.
                durableStorage: storageIsDurable(),
                budget: { spentTodayUsd: Number(spend.toFixed(4)), dailyLimitUsd: DAILY_BUDGET_USD },
                models: availableAliases().map(a => a.id),
                accounts: !hasAccounts() ? 'not-configured'
                    : storageIsDurable() ? 'ready'
                    : 'blocked-no-durable-storage',
                // Surfaced because a Discord redirect_uri mismatch is otherwise
                // diagnosed only by reading Discord's error page.
                publicUrl: publicUrl() || null
            });
        }

        if (req.method === 'POST' && path === '/v1/device') {
            return json(res, 200, {
                token: mintDeviceToken(),
                note: 'Store this once and reuse it. A new token starts a new free allowance, ' +
                      'but the service also buckets on your Zwift athlete id.'
            });
        }

        if (req.method === 'GET' && path === '/v1/models') {
            return json(res, 200, {
                object: 'list',
                data: availableAliases().map(a => ({
                    id: a.id,
                    object: 'model',
                    owned_by: 'lunatic',
                    label: a.label,
                    description: a.description
                }))
            });
        }

        if (req.method === 'GET' && path === '/v1/styles') {
            return json(res, 200, { object: 'list', default: DEFAULT_STYLE, data: listStyles() });
        }

        /**
         * The full prompt definitions, for clients that build their own request.
         *
         * A Sauce mod only updates when a rider downloads a new zip, so without
         * this an improved voice never reaches anyone already using their own
         * API key. Hosted riders need nothing here: the service substitutes the
         * system prompt at call time, so they are already current.
         *
         * Unauthenticated on purpose. Requiring a token would mean a rider who
         * chose NOT to use the hosted service had to connect to it anyway.
         */
        if ((req.method === 'GET' || req.method === 'HEAD') && path === '/v1/prompts') {
            const revision = promptsRevision();
            const etag = `"${revision}"`;
            // Both forms: a browser may send the value back verbatim or, on a
            // 304 revalidation, wrapped as a weak validator.
            const seen = String(req.headers['if-none-match'] || '')
                .split(',').map(v => v.trim().replace(/^W\//, ''));
            if (seen.includes(etag)) {
                res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache', ...corsHeaders() });
                return res.end();
            }
            const payload = {
                object: 'list',
                revision,
                default: DEFAULT_STYLE,
                data: listPromptDefinitions()
            };
            // HEAD gets the validator and the length, and no body: it is the
            // natural way for a monitor to ask "has this changed" without
            // pulling ~10KB of prompt text.
            if (req.method === 'HEAD') {
                const body = JSON.stringify(payload);
                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                    ETag: etag,
                    'Cache-Control': 'no-cache',
                    ...corsHeaders()
                });
                return res.end();
            }
            return json(res, 200, payload, { ETag: etag, 'Cache-Control': 'no-cache' });
        }

        if (req.method === 'GET' && path === '/v1/quota') {
            const ident = await identify(req);
            if (ident.kind === 'anonymous') {
                return apiError(res, 401, 'Missing or invalid token.', 'invalid_token');
            }
            const q = await quotaFor(ident.bucket, ident.tier);
            return json(res, 200, {
                ...q,
                tier: ident.tier,
                account: ident.kind === 'account' ? { name: ident.label } : null
            });
        }

        // --- Discord sign-in -------------------------------------------------
        // Every one of these refuses without durable storage. Losing a quota
        // counter on redeploy is annoying; losing an ACCOUNT means a rider's
        // key stops working and there is nothing they can do about it.
        const accountsReady = hasAccounts() && storageIsDurable();

        if (path === '/v1/pair/start' && req.method === 'POST') {
            if (!accountsReady) {
                return apiError(res, 503, accountsUnavailableReason(), 'accounts_unavailable');
            }
            const { code, pollToken, verifyUrl, expiresIn } = await startPairing();
            return json(res, 200, { code, pollToken, verifyUrl, expiresIn });
        }

        if (path === '/v1/pair/poll' && (req.method === 'POST' || req.method === 'GET')) {
            if (!accountsReady) {
                return apiError(res, 503, accountsUnavailableReason(), 'accounts_unavailable');
            }
            const body = req.method === 'POST' ? await readBody(req) : {};
            const token = body.pollToken || url.searchParams.get('token') || '';
            return json(res, 200, await pollPairing(token));
        }

        if (path === '/auth/discord/start' && req.method === 'GET') {
            if (!accountsReady) {
                res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
                return res.end(errorPage(accountsUnavailableReason()));
            }
            const target = await discordAuthorizeUrl(url.searchParams.get('code'));
            res.writeHead(302, { Location: target, ...corsHeaders() });
            return res.end();
        }

        if (path === '/auth/discord/callback' && req.method === 'GET') {
            if (!accountsReady) {
                res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
                return res.end(errorPage(accountsUnavailableReason()));
            }
            try {
                const result = await handleDiscordCallback({
                    code: url.searchParams.get('code'),
                    state: url.searchParams.get('state')
                });
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                return res.end(successPage(result));
            } catch (err) {
                console.error('[discord] callback failed:', err.message);
                res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                return res.end(errorPage(err.message || 'Sign-in failed.'));
            }
        }

        if (req.method === 'POST' && path === '/v1/chat/completions') {
            const body = await readBody(req);
            return await handleChat(req, res, body);
        }

        return apiError(res, 404, `No route for ${req.method} ${path}.`, 'not_found');

    } catch (err) {
        console.error('[server]', err);
        if (res.headersSent) return res.end();
        return apiError(res, err.status || 500, err.status ? err.message : 'Internal error.', 'internal_error');
    }
});

// Streams here are long-lived by design; the default 5s keep-alive would cut a
// slow first token.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;

await initStorage();

server.listen(PORT, () => {
    const aliases = availableAliases();
    console.log(`[lunatic] listening on :${PORT}`);
    console.log(`[lunatic] models: ${aliases.map(a => a.id).join(', ') || 'NONE CONFIGURED'}`);
    console.log(`[lunatic] daily budget: $${DAILY_BUDGET_USD}, durable storage: ${storageIsDurable()}`);
    if (!aliases.length) {
        console.warn('[lunatic] No usable model aliases. Set at least FAST_MODEL + a matching API key.');
    }
});
