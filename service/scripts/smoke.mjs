#!/usr/bin/env node
/**
 * Smoke-test a deployed Lunatic service.
 *
 *   node scripts/smoke.mjs https://your-app.up.railway.app
 *   node scripts/smoke.mjs https://your-app.up.railway.app --live
 *
 * Without --live nothing reaches a model, so the run is free. --live adds one
 * real commentary call, which costs a fraction of a cent and consumes one of
 * that device token's monthly calls.
 *
 * Exit code is non-zero if any check fails, so this can gate a deploy.
 */

const base = (process.argv[2] || '').replace(/\/+$/, '');
const live = process.argv.includes('--live');

if (!base || !/^https?:\/\//.test(base)) {
    console.error('usage: node scripts/smoke.mjs <service-url> [--live]');
    process.exit(2);
}

let failed = 0;
let warned = 0;

const pass = (name, detail = '') => console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
const fail = (name, detail = '') => { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); };
const warn = (name, detail = '') => { warned++; console.log(`  WARN  ${name}${detail ? ` — ${detail}` : ''}`); };

async function get(path, options) {
    const res = await fetch(`${base}${path}`, options);
    const body = await res.json().catch(() => ({}));
    return { res, body };
}

console.log(`\nSmoke-testing ${base}${live ? ' (live model call enabled)' : ''}\n`);

// --- health ----------------------------------------------------------------
let health;
try {
    const { res, body } = await get('/healthz');
    health = body;
    if (res.ok && body.ok) pass('healthz reachable');
    else fail('healthz reachable', `status ${res.status}`);
} catch (err) {
    fail('healthz reachable', err.message);
    console.log('\nThe service is not answering. Check the Railway deploy logs.\n');
    process.exit(1);
}

// The single most consequential deployment mistake: without Redis the quota
// counters AND the daily spend breaker reset on every deploy.
if (health.durableStorage) {
    pass('durable storage', 'Redis connected');
} else {
    warn('durable storage', 'IN-MEMORY — quotas and the spend breaker reset on every ' +
                            'deploy and restart. Add the Redis plugin before going public.');
}

if (health.budget) {
    pass('spend breaker configured',
        `$${health.budget.spentTodayUsd} spent today of $${health.budget.dailyLimitUsd}`);
    if (!(health.budget.dailyLimitUsd > 0)) {
        fail('daily budget', 'DAILY_BUDGET_USD is not a positive number — the bill is unbounded');
    }
} else {
    fail('spend breaker configured', 'no budget in /healthz');
}

// Accounts are optional, but a half-configured state is worth naming: the
// button appears in the mod and then fails.
if (health.accounts === 'ready') {
    pass('discord sign-in', 'configured and storage is durable');
} else if (health.accounts === 'blocked-no-durable-storage') {
    fail('discord sign-in', 'CONFIGURED BUT BLOCKED — no Redis, so accounts would be ' +
                            'lost on the next deploy. Sign-in returns 503 until that is fixed.');
} else {
    warn('discord sign-in', 'not configured — riders can only connect anonymously');
}

if (health.publicUrl) pass('public url', health.publicUrl);

// --- models ----------------------------------------------------------------
const { body: models } = await get('/v1/models');
const aliases = (models.data || []).map(m => m.id);
if (aliases.length) pass('models offered', aliases.join(', '));
else fail('models offered', 'none — set at least FAST_MODEL and a matching API key');

if (aliases.length < 3) {
    warn('three free models', `only ${aliases.length} configured; an alias needs both a model id and a key`);
} else {
    pass('three free models');
}

// --- styles ----------------------------------------------------------------
const { body: styles } = await get('/v1/styles');
if ((styles.data || []).length) pass('voices offered', styles.data.map(s => s.id).join(', '));
else fail('voices offered', 'none');

// --- auth ------------------------------------------------------------------
const { body: dev } = await get('/v1/device', { method: 'POST' });
if (typeof dev.token === 'string' && dev.token.startsWith('lun_')) pass('device token minted');
else fail('device token minted', JSON.stringify(dev).slice(0, 120));

const auth = { Authorization: `Bearer ${dev.token}` };

const { res: noAuth } = await get('/v1/quota');
if (noAuth.status === 401) pass('unauthenticated requests rejected');
else fail('unauthenticated requests rejected', `got ${noAuth.status}, expected 401`);

const { body: quota } = await get('/v1/quota', { headers: auth });
if (typeof quota.remaining === 'number') pass('quota readable', `${quota.remaining} of ${quota.limit}`);
else fail('quota readable', JSON.stringify(quota).slice(0, 120));

// --- prompt size cap -------------------------------------------------------
const { res: big } = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(40000) }] })
}).then(r => ({ res: r }));
if (big.status === 413) pass('oversized prompt rejected');
else fail('oversized prompt rejected', `got ${big.status}, expected 413`);

// --- live call -------------------------------------------------------------
if (live) {
    const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json', 'X-Lunatic-Athlete': '1' },
        body: JSON.stringify({
            model: aliases[0],
            style: 'tour',
            stream: true,
            messages: [{
                role: 'user',
                content: 'EVENTS:\n- Vermeulen attacks, 640W\n\nFIELD (front to back):\n' +
                         '- Vermeulen J.  8s up the road  5s: 640W\n>> (you)  380W\n\nCall it.'
            }]
        })
    });

    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        fail('live commentary call', body?.error?.message || `status ${res.status}`);
    } else {
        // Read the stream and reassemble, exactly as the mod does.
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        let text = '';
        let sawUsage = false;
        let firstTokenMs = null;
        const started = Date.now();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split(/\r?\n/);
            buf = lines.pop() || '';
            for (const line of lines) {
                const m = /^data:[ \t]?/.exec(line);
                if (!m) continue;
                const raw = line.slice(m[0].length);
                if (raw === '[DONE]') continue;
                let p;
                try { p = JSON.parse(raw); } catch { continue; }
                const d = p.choices?.[0]?.delta?.content;
                if (d) {
                    if (firstTokenMs === null) firstTokenMs = Date.now() - started;
                    text += d;
                }
                if (p.usage) sawUsage = true;
            }
        }

        if (text.trim()) pass('live commentary call', JSON.stringify(text.trim()));
        else fail('live commentary call', 'empty response — the model may be spending the ' +
                                          'output budget on reasoning tokens');

        if (sawUsage) pass('usage reported', 'the spend breaker can see this call');
        else fail('usage reported', 'NO usage — the breaker will count this call as free');

        if (firstTokenMs !== null) {
            const label = `${firstTokenMs}ms to first token`;
            if (firstTokenMs < 2500) pass('latency', label);
            else warn('latency', `${label} — speech starts at the first sentence, so this is felt`);
        }
    }
} else {
    console.log('  SKIP  live commentary call — pass --live to spend one real call');
}

console.log();
if (failed) {
    console.log(`${failed} check(s) failed${warned ? `, ${warned} warning(s)` : ''}.\n`);
    process.exit(1);
}
console.log(`All checks passed${warned ? `, with ${warned} warning(s) to address before going public` : ''}.\n`);
