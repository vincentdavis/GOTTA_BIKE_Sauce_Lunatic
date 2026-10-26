#!/usr/bin/env node
/**
 * The release notes for one version, from the commits in it.
 *
 * `generate_release_notes` only ever produced a bare compare link here: it
 * lists pull requests, and this repo ships straight to main. So every release
 * carried the same fixed Install text and said nothing about what was in it —
 * v0.8.9 added posting to Zwift chat and its notes described the three
 * providers, exactly as v0.4.1's had.
 *
 * Subjects only. The commit bodies in this repo run to forty lines and belong
 * in `git log`, not on a download page.
 *
 *   node scripts/release-notes.mjs 0.8.9          # the notes for HEAD
 *   node scripts/release-notes.mjs 0.8.5 v0.8.5   # ...as of an older tag
 */
import { execFileSync } from 'node:child_process';

/** A conventional-commit type to the heading it belongs under. */
const HEADINGS = {
    feat: 'New',
    fix: 'Fixed',
    perf: 'Fixed',
    docs: 'Docs'
};
/** Printed in this order; anything unrecognised falls to the last. */
const ORDER = ['New', 'Fixed', 'Docs', 'Also'];

const INSTALL = `## Install

1. Download the zip below.
2. Unzip it into \`~/Documents/SauceMods/\` (macOS) so you have
   \`SauceMods/GOTTA_BIKE_Sauce_Lunatic/manifest.json\`.
3. Restart Sauce4Zwift and enable the mod, then open the
   **Lunatic Announcer** window.

Replace the existing folder rather than unzipping over it, so files removed in
this version do not linger.

## Pick a provider

On the **AI Provider** tab, choose one of:

- **Lunatic hosted** — no API key, a monthly allowance of free calls.
- **Anthropic** — your own key, billed to your account.
- **OpenAI-compatible** — OpenAI, Google Gemini, OpenRouter, Groq, or a local
  Ollama.

Whichever you choose, rider data leaves your machine: the names, power and heart
rate of riders around you are sent to that service.

Spoken commentary is **on by default**, using the voices built into your
computer (macOS and Windows alike). The speaker button in the window titlebar
mutes it.`;

/**
 * Build the notes. Pure, so the shape can be tested without a git history.
 *
 * @param {string} tag      this release, e.g. 'v0.8.9'
 * @param {string} prev     the previous tag, or '' for the first release
 * @param {string[]} subjects  commit subject lines, newest first
 */
export function formatNotes({ tag, prev, subjects }) {
    const buckets = Object.fromEntries(ORDER.map(h => [h, []]));

    for (const subject of subjects) {
        const m = /^(\w+)(?:\(([^)]*)\))?!?:\s*(.+)$/.exec(subject);
        if (!m) {
            // Not a conventional commit. Keep it rather than dropping it: a
            // release note that silently omits a change is worse than an untidy
            // one.
            buckets.Also.push(subject);
            continue;
        }
        const [, kind, scope, text] = m;
        const heading = HEADINGS[kind.toLowerCase()] || 'Also';
        buckets[heading].push(scope ? `**${scope}** — ${text}` : text);
    }

    const out = [`## What changed in ${tag}`, ''];
    if (prev) out.push(`Since ${prev}.`, '');
    if (!subjects.length) out.push('No commits since the previous release.', '');
    for (const heading of ORDER) {
        if (!buckets[heading].length) continue;
        out.push(`### ${heading}`, ...buckets[heading].map(l => `- ${l}`), '');
    }
    out.push(INSTALL);
    return out.join('\n');
}

const git = (...args) =>
    execFileSync('git', args, { encoding: 'utf8' }).trim();

/** The newest version tag that is an ancestor of `at` and is not this one. */
export function previousTag(tag, at = 'HEAD') {
    // --merged, so a tag on an abandoned branch cannot become the baseline.
    // Excluding `tag` matters because a tag-push run already has it.
    const tags = git('tag', '-l', 'v*', '--merged', at, '--sort=-v:refname')
        .split('\n').map(t => t.trim()).filter(t => t && t !== tag);
    return tags[0] || '';
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const version = process.argv[2];
    if (!version) {
        console.error('usage: node scripts/release-notes.mjs <version>');
        process.exit(2);
    }
    const tag = version.startsWith('v') ? version : `v${version}`;
    // A second argument walks an EARLIER release, which is how the notes for
    // the releases published before this script existed were written.
    const at = process.argv[3] || 'HEAD';
    const prev = previousTag(tag, at);
    const span = prev ? `${prev}..${at}` : at;
    const subjects = git('log', span, '--no-merges', '--pretty=%s')
        .split('\n').map(s => s.trim()).filter(Boolean);
    process.stdout.write(`${formatNotes({ tag, prev, subjects })}\n`);
}
