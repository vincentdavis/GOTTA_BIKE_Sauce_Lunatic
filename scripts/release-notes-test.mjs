#!/usr/bin/env node
/**
 * The release notes say what is in the release.
 *
 * Every release from v0.4.1 to v0.8.9 carried identical notes — the three
 * providers and how to unzip — because `generate_release_notes` lists pull
 * requests and this repo ships straight to main. Nobody noticed for six
 * releases, which is what an untested generator looks like.
 *
 * formatNotes() is pure, so this drives it with commit subjects rather than
 * with a git history: the shape is what matters, and a shallow CI clone must
 * not be able to make this pass vacuously.
 *
 *   node scripts/release-notes-test.mjs
 */
import { formatNotes } from './release-notes.mjs';

let bad = 0;
const check = (n, ok, d = '') => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`);
    if (!ok) bad++;
};
const section = t => console.log(`\n=== ${t} ===`);

// ---------------------------------------------------------------------------
section('a release describes itself');
{
    const notes = formatNotes({
        tag: 'v0.8.9', prev: 'v0.8.8',
        subjects: [
            "feat(chat): optionally post a line into Zwift's own chat",
            'fix(overlay): the previous lines were pinned to the bottom',
            'docs: record the findings as fixed',
            'test: boot the settings window with no voices'
        ]
    });

    check('it names the version', notes.includes('## What changed in v0.8.9'));
    check('and what it is measured against', notes.includes('Since v0.8.8.'));
    check('features land under New',
        /### New\n- \*\*chat\*\* — optionally post/.test(notes));
    check('fixes under Fixed',
        /### Fixed\n- \*\*overlay\*\* — the previous lines/.test(notes));
    check('docs under Docs', /### Docs\n- record the findings/.test(notes));
    // Anything unrecognised is kept, not dropped: notes that silently omit a
    // change are worse than untidy ones.
    check('and anything else is still listed',
        /### Also\n- boot the settings window/.test(notes));

    const order = ['### New', '### Fixed', '### Docs', '### Also']
        .map(h => notes.indexOf(h));
    check('in that order', order.every((n, i) => i === 0 || n > order[i - 1]),
        order.join(', '));

    check('the install steps survive', notes.includes('SauceMods/GOTTA_BIKE_Sauce_Lunatic/manifest.json'));
    check('and the one thing a rider must know before installing',
        /rider data leaves your machine/.test(notes));
}

// ---------------------------------------------------------------------------
section('the awkward ones');
{
    const first = formatNotes({ tag: 'v0.1.0', prev: '', subjects: ['feat: the first one'] });
    check('a first release does not claim a baseline it has not got',
        !first.includes('Since '), first.split('\n').slice(0, 4).join(' / '));
    check('but still lists its commits', first.includes('- the first one'));

    const empty = formatNotes({ tag: 'v0.9.0', prev: 'v0.8.9', subjects: [] });
    check('nothing to say says so', empty.includes('No commits since the previous release.'));
    check('and still carries the install steps', empty.includes('## Install'));

    const odd = formatNotes({
        tag: 'v1.0.0', prev: 'v0.9.0',
        subjects: ['feat!: a breaking change', 'chore(deps)!: bump a thing', 'a bare subject']
    });
    check('a breaking-change marker does not break the parse',
        /### New\n- a breaking change/.test(odd), odd);
    check('a scope survives one too', /- \*\*deps\*\* — bump a thing/.test(odd));
    check('and a non-conventional subject is kept', /- a bare subject/.test(odd));
}

console.log(bad ? `\n${bad} check(s) failed.` : '\nall checks passed');
process.exit(bad ? 1 : 0);
