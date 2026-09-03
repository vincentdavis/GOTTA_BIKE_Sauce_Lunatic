/**
 * Upstream provider calls, normalized to one event stream.
 *
 * Mirrors pages/src/providers.mjs in the mod, and for the same reasons:
 *
 *   - buildRequest returns a COMPLETE header set (no shared base object).
 *   - usage is read as ABSOLUTE counts with last-write-wins, which absorbs the
 *     three different ways providers report it.
 *
 * Callers get an async generator of {text} events followed by one {usage}
 * event. Nothing above this file knows which provider answered.
 */

// Anthropic model ids that run adaptive thinking unless told not to. Thinking
// tokens bill against max_tokens, so at a ~60 token output cap the entire
// budget disappears into reasoning and the stream comes back empty.
const ANTHROPIC_THINKING_OFF = new Set(['claude-sonnet-5', 'claude-opus-5']);

function anthropicRequest({ model, apiKey, systemPrompt, userPrompt, maxTokens }) {
    const thinkingOff = ANTHROPIC_THINKING_OFF.has(model);
    return {
        url: 'https://api.anthropic.com/v1/messages',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
        },
        body: {
            model,
            max_tokens: maxTokens,
            system: thinkingOff
                ? `${systemPrompt}\n\nDo not include internal or system XML tags in your response.`
                : systemPrompt,
            ...(thinkingOff ? { thinking: { type: 'disabled' } } : {}),
            messages: [{ role: 'user', content: userPrompt }],
            stream: true
        }
    };
}

function openaiRequest({ model, apiKey, baseUrl, systemPrompt, userPrompt, maxTokens, extraBody }) {
    const root = String(baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    return {
        url: `${root}/chat/completions`,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`
        },
        body: {
            model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            max_tokens: maxTokens,
            stream: true,
            // Without this there is no usage at all, and the spend breaker
            // would count every call as free.
            stream_options: { include_usage: true },
            ...(extraBody || {})
        }
    };
}

function anthropicEvent(p) {
    if (p.type === 'error') {
        return { error: p.error?.message || p.error?.type || 'upstream streaming error' };
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

function openaiEvent(p) {
    if (p.error) return { error: p.error.message || p.error.type || 'upstream streaming error' };
    const text = p.choices?.[0]?.delta?.content;
    if (text) return { text };
    // The usage chunk carries `choices: []`, so the access above must stay
    // optional or it throws mid-stream.
    if (p.usage) {
        return {
            inputTokens: p.usage.prompt_tokens || 0,
            outputTokens: p.usage.completion_tokens || 0
        };
    }
    return null;
}

/** Yield each `data:` payload from an SSE response body. */
async function* sseFrames(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // CRLF-tolerant: Google's frames are CRLF-terminated, which would
        // otherwise leave the sentinel comparing as '[DONE]\r'.
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) {
            const m = /^data:[ \t]?/.exec(line);
            if (!m) continue;
            yield line.slice(m[0].length);
        }
    }
}

export class UpstreamError extends Error {
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}

/**
 * Call the upstream model for one alias.
 *
 * @yields {{text:string}} for each delta, then {{usage:{inputTokens,outputTokens}}}
 */
export async function* callUpstream({ alias, systemPrompt, userPrompt, maxTokens, signal }) {
    const isAnthropic = alias.provider === 'anthropic';
    const req = isAnthropic
        ? anthropicRequest({ ...alias, systemPrompt, userPrompt, maxTokens })
        : openaiRequest({ ...alias, systemPrompt, userPrompt, maxTokens });
    const readEvent = isAnthropic ? anthropicEvent : openaiEvent;

    const response = await fetch(req.url, {
        method: 'POST',
        headers: req.headers,
        body: JSON.stringify(req.body),
        signal
    });

    if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        // Never surface the upstream message verbatim: it can name the account,
        // the key or internal quota details that are not the caller's business.
        console.error('[upstream] %s %s -> %s: %s',
            alias.provider, alias.model, response.status,
            body?.error?.message || '(no message)');
        const status = response.status === 429 || response.status >= 500 ? 503 : 502;
        throw new UpstreamError('The upstream model is unavailable right now.', status);
    }

    let inputTokens = 0;
    let outputTokens = 0;

    for await (const raw of sseFrames(response)) {
        if (raw === '[DONE]') continue;

        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch {
            continue;
        }

        const ev = readEvent(parsed);
        if (!ev) continue;

        if (ev.error) throw new UpstreamError('The upstream model failed mid-response.', 502);
        if (ev.text) yield { text: ev.text };
        // Absolute, not incremental.
        if (ev.inputTokens != null) inputTokens = ev.inputTokens;
        if (ev.outputTokens != null) outputTokens = ev.outputTokens;
    }

    yield { usage: { inputTokens, outputTokens } };
}
