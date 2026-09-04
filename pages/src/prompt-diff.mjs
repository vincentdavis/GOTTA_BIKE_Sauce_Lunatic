/**
 * A line diff, for showing what changed in a prompt.
 *
 * Prompts are line-oriented -- a paragraph of character, then numbered rules --
 * so a line diff lands exactly on the unit a person edits. A word diff would
 * scatter highlights through a rule that was rewritten wholesale, and a
 * character diff would be unreadable.
 *
 * No dependencies, because this mod has no build step: an LCS table is about
 * thirty lines and the inputs are a few dozen lines each.
 */

/**
 * Above this, the O(n*m) table stops being free. Nothing legitimate comes
 * close -- the longest built-in is under 50 lines -- so hitting it means
 * something pathological, and "replaced wholesale" is a truthful answer for
 * text nobody could read a diff of anyway.
 */
const MAX_LINES = 600;

/**
 * @returns {{type: 'same'|'add'|'del', text: string}[]} in output order:
 *   deletions before the additions that replace them.
 */
export function diffLines(before, after) {
    const a = String(before ?? '').split('\n');
    const b = String(after ?? '').split('\n');

    if (a.length > MAX_LINES || b.length > MAX_LINES) {
        return [
            ...a.map(text => ({ type: 'del', text })),
            ...b.map(text => ({ type: 'add', text }))
        ];
    }

    // lcs[i][j] = length of the longest common subsequence of a[i:] and b[j:].
    // Built from the end so the walk below runs forward, which keeps the output
    // in reading order without a reverse.
    const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            lcs[i][j] = a[i] === b[j]
                ? lcs[i + 1][j + 1] + 1
                : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
        }
    }

    const out = [];
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
            out.push({ type: 'same', text: a[i] });
            i++; j++;
        } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
            out.push({ type: 'del', text: a[i] });
            i++;
        } else {
            out.push({ type: 'add', text: b[j] });
            j++;
        }
    }
    while (i < a.length) out.push({ type: 'del', text: a[i++] });
    while (j < b.length) out.push({ type: 'add', text: b[j++] });
    return out;
}

export function summarize(hunks) {
    return {
        added: hunks.filter(h => h.type === 'add').length,
        removed: hunks.filter(h => h.type === 'del').length
    };
}

/**
 * Drop long runs of unchanged lines, keeping `context` either side of a change.
 *
 * A prompt is forty lines and a rewording touches two. Without this the change
 * is buried in the thirty-eight that did not move, which is the whole reason
 * someone opened the diff.
 *
 * Elided runs become a single {type:'gap', count} so the reader can see that
 * something was skipped rather than that the text simply ends.
 */
export function collapse(hunks, context = 2) {
    const keep = new Array(hunks.length).fill(false);
    hunks.forEach((h, n) => {
        if (h.type === 'same') return;
        for (let k = Math.max(0, n - context); k <= Math.min(hunks.length - 1, n + context); k++) {
            keep[k] = true;
        }
    });

    const out = [];
    let skipped = 0;
    hunks.forEach((h, n) => {
        if (keep[n]) {
            // A gap of one line is longer to describe than to show.
            if (skipped > 1) out.push({ type: 'gap', count: skipped });
            else if (skipped === 1) out.push(hunks[n - 1]);
            skipped = 0;
            out.push(h);
        } else {
            skipped++;
        }
    });
    if (skipped > 1) out.push({ type: 'gap', count: skipped });
    else if (skipped === 1) out.push(hunks[hunks.length - 1]);
    return out;
}

/** Both fields of a prompt, diffed, with the unchanged middle removed. */
export function diffPrompts(before, after, { context = 2 } = {}) {
    const parts = [];
    for (const [label, field] of [['System message', 'systemPrompt'],
                                  ['User template', 'userPromptTemplate']]) {
        const hunks = diffLines(before?.[field], after?.[field]);
        const counts = summarize(hunks);
        // A field nobody touched should not take up space in the view.
        if (!counts.added && !counts.removed) continue;
        parts.push({ label, ...counts, hunks: collapse(hunks, context) });
    }
    return parts;
}
