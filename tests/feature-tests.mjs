// Standalone test suite for the Tier 1/2 feature adds. No network, no live auth.
// Run: node tests/feature-tests.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, stat, readFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
    isSafeMediaHost, upgradePhotoUrl, extForMedia, selectMediaDownloads, computeBackoffMs, downloadOne,
} from '../dist/lib/media-download.js';
import { expandShortUrls, urlEntitiesFromResult } from '../dist/lib/url-expand.js';
import { extractBioEntities, normalizeAffiliation } from '../dist/lib/profile-enrich.js';
import { resolveGitSha } from '../dist/lib/version.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const readme = readFileSync(path.join(repoRoot, 'README.md'), 'utf8');

let passed = 0;
let failed = 0;
async function test(name, fn) {
    try {
        await fn();
        passed += 1;
        console.log(`  ok   ${name}`);
    }
    catch (e) {
        failed += 1;
        console.log(`  FAIL ${name}\n       ${e.message}`);
    }
}

async function createLinkedWorktreeFixture({ packed = false } = {}) {
    const root = await mkdtemp(path.join(tmpdir(), 'bird-version-worktree-'));
    const commonGitDir = path.join(root, 'repo', '.git');
    const worktreeGitDir = path.join(commonGitDir, 'worktrees', 'linked');
    const checkoutDir = path.join(root, 'repo', '.worktrees', 'linked');
    const linkedRef = 'refs/heads/feature/linked';
    const linkedSha = '1234567890abcdef1234567890abcdef12345678';
    const mainSha = 'abcdef1234567890abcdef1234567890abcdef12';

    await mkdir(worktreeGitDir, { recursive: true });
    await mkdir(path.join(commonGitDir, 'refs', 'heads'), { recursive: true });
    await mkdir(path.join(root, 'repo', 'dist', 'lib'), { recursive: true });
    await mkdir(path.join(checkoutDir, 'dist', 'lib'), { recursive: true });
    await writeFile(path.join(checkoutDir, '.git'), `gitdir: ${worktreeGitDir}\n`);
    await writeFile(path.join(worktreeGitDir, 'HEAD'), `ref: ${linkedRef}\n`);
    await writeFile(path.join(worktreeGitDir, 'commondir'), '../..\n');
    await writeFile(path.join(commonGitDir, 'HEAD'), 'ref: refs/heads/main\n');
    await writeFile(path.join(commonGitDir, 'refs', 'heads', 'main'), `${mainSha}\n`);
    if (packed) {
        await writeFile(path.join(commonGitDir, 'packed-refs'), `${linkedSha} ${linkedRef}\n`);
    }
    else {
        await mkdir(path.dirname(path.join(commonGitDir, linkedRef)), { recursive: true });
        await writeFile(path.join(commonGitDir, linkedRef), `${linkedSha}\n`);
    }

    return {
        importMetaUrl: pathToFileURL(path.join(checkoutDir, 'dist', 'lib', 'version.js')).href,
        linkedSha: linkedSha.slice(0, 8),
        mainImportMetaUrl: pathToFileURL(path.join(root, 'repo', 'dist', 'lib', 'version.js')).href,
        mainSha: mainSha.slice(0, 8),
        root,
        worktreeGitDir,
    };
}

async function withoutInjectedGitSha(callback) {
    const previousInjectedSha = process.env.BIRD_GIT_SHA;
    try {
        delete process.env.BIRD_GIT_SHA;
        return await callback();
    }
    finally {
        if (previousInjectedSha === undefined) {
            delete process.env.BIRD_GIT_SHA;
        }
        else {
            process.env.BIRD_GIT_SHA = previousInjectedSha;
        }
    }
}

console.log('release metadata + linked-worktree version');
await test('package metadata keeps every offline npm test gate authoritative', () => {
    assert.equal(packageJson.version, '1.1.0');
    assert.match(packageJson.description, /analytics/i);
    assert.equal(
        packageJson.scripts.test,
        'node tests/feature-tests.mjs && node tests/analytics-tests.mjs && npm run test:types',
    );
});
await test('README Node requirement matches the package engine', () => {
    assert.equal(packageJson.engines.node, '>=22');
    assert.match(readme, /Requires \*\*Node 22\+\*\*/);
    assert.doesNotMatch(readme, /Requires \*\*Node 18\+\*\*/);
});
await test('CLI version SHA matches the current linked-worktree HEAD', () => {
    const expected = spawnSync('git', ['rev-parse', '--short=8', 'HEAD'], {
        cwd: repoRoot,
        encoding: 'utf8',
    });
    const actual = spawnSync(process.execPath, ['dist/cli.js', '--version'], {
        cwd: repoRoot,
        encoding: 'utf8',
    });
    assert.equal(expected.status, 0, expected.stderr);
    assert.equal(actual.status, 0, actual.stderr);
    assert.match(actual.stdout.trim(), new RegExp(`\\(${expected.stdout.trim()}\\)$`));
});
for (const packed of [false, true]) {
    await test(`resolves a linked-worktree ref from common ${packed ? 'packed' : 'loose'} refs`, async () => {
        const fixture = await createLinkedWorktreeFixture({ packed });
        try {
            await withoutInjectedGitSha(() => {
                assert.equal(resolveGitSha(fixture.importMetaUrl), fixture.linkedSha);
            });
        }
        finally {
            await rm(fixture.root, { recursive: true, force: true });
        }
    });
}
await test('preserves ordinary repository symbolic-ref resolution', async () => {
    const fixture = await createLinkedWorktreeFixture();
    try {
        await withoutInjectedGitSha(() => {
            assert.equal(resolveGitSha(fixture.mainImportMetaUrl), fixture.mainSha);
        });
    }
    finally {
        await rm(fixture.root, { recursive: true, force: true });
    }
});
await test('preserves detached linked-worktree HEAD resolution', async () => {
    const fixture = await createLinkedWorktreeFixture();
    try {
        await writeFile(path.join(fixture.worktreeGitDir, 'HEAD'), 'fedcba9876543210fedcba9876543210fedcba98\n');
        await withoutInjectedGitSha(() => {
            assert.equal(resolveGitSha(fixture.importMetaUrl), 'fedcba98');
        });
    }
    finally {
        await rm(fixture.root, { recursive: true, force: true });
    }
});
await test('preserves injected Git SHA precedence and truncation', () => {
    const previousInjectedSha = process.env.BIRD_GIT_SHA;
    try {
        process.env.BIRD_GIT_SHA = '0123456789abcdef';
        assert.equal(resolveGitSha('file:///synthetic/nonexistent/version.js'), '01234567');
    }
    finally {
        if (previousInjectedSha === undefined) {
            delete process.env.BIRD_GIT_SHA;
        }
        else {
            process.env.BIRD_GIT_SHA = previousInjectedSha;
        }
    }
});

console.log('media-download — host safety + variant helpers');
await test('isSafeMediaHost allows X CDN, rejects others', () => {
    assert.equal(isSafeMediaHost('https://pbs.twimg.com/media/A.jpg'), true);
    assert.equal(isSafeMediaHost('https://video.twimg.com/x.mp4'), true);
    assert.equal(isSafeMediaHost('https://ton.twimg.com/x'), true);
    assert.equal(isSafeMediaHost('http://pbs.twimg.com/media/A.jpg'), false); // not https
    assert.equal(isSafeMediaHost('https://evil.com/A.jpg'), false);
    assert.equal(isSafeMediaHost('not a url'), false);
});
await test('upgradePhotoUrl requests original resolution for pbs media', () => {
    assert.equal(upgradePhotoUrl('https://pbs.twimg.com/media/A.jpg'), 'https://pbs.twimg.com/media/A.jpg?name=orig');
    assert.equal(upgradePhotoUrl('https://video.twimg.com/x.mp4'), 'https://video.twimg.com/x.mp4'); // untouched
});
await test('extForMedia picks correct extensions', () => {
    assert.equal(extForMedia({ type: 'video', videoUrl: 'https://video.twimg.com/x.mp4' }), 'mp4');
    assert.equal(extForMedia({ type: 'animated_gif', videoUrl: 'https://video.twimg.com/x.mp4' }), 'mp4');
    assert.equal(extForMedia({ type: 'photo', url: 'https://pbs.twimg.com/media/A.jpg' }), 'jpg');
    assert.equal(extForMedia({ type: 'photo', url: 'https://pbs.twimg.com/media/A?format=png' }), 'png');
});
await test('selectMediaDownloads builds a plan with filenames', () => {
    const tweet = {
        id: '100',
        media: [
            { type: 'photo', url: 'https://pbs.twimg.com/media/A.jpg' },
            { type: 'video', videoUrl: 'https://video.twimg.com/B.mp4' },
        ],
        quotedTweet: { id: '200', media: [{ type: 'photo', url: 'https://pbs.twimg.com/media/C.jpg' }] },
    };
    const plan = selectMediaDownloads(tweet);
    assert.equal(plan.length, 2);
    assert.equal(plan[0].filename, '100-1.jpg');
    assert.equal(plan[0].url, 'https://pbs.twimg.com/media/A.jpg?name=orig');
    assert.equal(plan[1].filename, '100-2.mp4');
    const withQuoted = selectMediaDownloads(tweet, { includeQuoted: true });
    assert.equal(withQuoted.length, 3);
    assert.equal(withQuoted[2].filename, 'quoted-200-1.jpg');
    assert.deepEqual(selectMediaDownloads({ id: '1' }), []);
});

console.log('media-download — backoff');
await test('computeBackoffMs honors x-rate-limit-reset on 429', () => {
    const now = 1_000_000_000_000;
    const resetSec = Math.floor(now / 1000) + 10; // 10s in the future
    const headers = new Map([['x-rate-limit-reset', String(resetSec)]]);
    const ms = computeBackoffMs({ status: 429, headers, attempt: 0, now });
    assert.equal(ms, 10_000 + 1000); // 10s + 1s buffer
});
await test('computeBackoffMs honors retry-after delta-seconds', () => {
    const headers = new Map([['retry-after', '7']]);
    assert.equal(computeBackoffMs({ status: 503, headers, attempt: 1 }), 7000);
});
await test('computeBackoffMs falls back to exponential backoff (jitter injected)', () => {
    assert.equal(computeBackoffMs({ status: 500, headers: new Map(), attempt: 0, baseMs: 500, jitter: 0 }), 500);
    assert.equal(computeBackoffMs({ status: 500, headers: new Map(), attempt: 2, baseMs: 500, jitter: 0 }), 2000);
});
await test('computeBackoffMs clamps to 15min max', () => {
    const headers = new Map([['retry-after', '99999']]);
    assert.equal(computeBackoffMs({ status: 429, headers, attempt: 0 }), 15 * 60 * 1000);
});

console.log('url-expand');
await test('expandShortUrls replaces t.co links with expanded_url', () => {
    const urls = [
        { url: 'https://t.co/aaa', expanded_url: 'https://example.com/page' },
        { url: 'https://t.co/bbb', expanded_url: 'https://github.com/x/y' },
    ];
    assert.equal(
        expandShortUrls('see https://t.co/aaa and https://t.co/bbb end', urls),
        'see https://example.com/page and https://github.com/x/y end');
});
await test('expandShortUrls is a no-op without entities', () => {
    assert.equal(expandShortUrls('hello https://t.co/aaa', undefined), 'hello https://t.co/aaa');
    assert.equal(expandShortUrls('hello', []), 'hello');
    assert.equal(expandShortUrls(undefined, []), undefined);
});
await test('urlEntitiesFromResult reads legacy.entities.urls', () => {
    const r = { legacy: { entities: { urls: [{ url: 't', expanded_url: 'e' }] } } };
    assert.equal(urlEntitiesFromResult(r).length, 1);
    assert.equal(urlEntitiesFromResult({}), undefined);
});

console.log('profile-enrich');
await test('extractBioEntities pulls handles, domains, companies; dedupes', () => {
    const ents = extractBioEntities('building @Acme · founder of Globex · see acme.com and acme.com');
    const handles = ents.filter((e) => e.kind === 'handle').map((e) => e.value);
    const domains = ents.filter((e) => e.kind === 'domain').map((e) => e.value);
    const companies = ents.filter((e) => e.kind === 'company').map((e) => e.value);
    assert.ok(handles.includes('@Acme'));
    assert.deepEqual(domains, ['acme.com']); // deduped
    assert.ok(companies.includes('Acme') || companies.includes('Globex'));
    assert.deepEqual(extractBioEntities(''), []);
});
await test('extractBioEntities skips false-positive domains like e.g.', () => {
    const ents = extractBioEntities('e.g. nothing here');
    assert.equal(ents.filter((e) => e.kind === 'domain').length, 0);
});
await test('normalizeAffiliation reads label + infers handle from url', () => {
    const user = {
        affiliates_highlighted_label: {
            label: { description: 'The New York Times', url: { url: 'https://x.com/nytimes' } },
        },
    };
    const aff = normalizeAffiliation(user);
    assert.equal(aff.label, 'The New York Times');
    assert.equal(aff.handle, '@nytimes');
    assert.equal(normalizeAffiliation({}), null);
    assert.equal(normalizeAffiliation(null), null);
});

console.log('media-download — downloader integration (injected fetch/sleep, offline)');
const dir = await mkdtemp(path.join(tmpdir(), 'bird-dl-'));
try {
    await test('downloadOne writes full body and removes .part atomically', async () => {
        const body = Buffer.from('hello world media bytes');
        const dest = path.join(dir, 'full.bin');
        const res = await downloadOne({
            url: 'https://video.twimg.com/full.mp4',
            dest,
            fetchImpl: async () => new Response(body, { status: 200 }),
        });
        assert.equal(res.ok, true);
        assert.equal(res.bytes, body.length);
        assert.equal((await readFile(dest)).toString(), 'hello world media bytes');
        assert.equal(existsSync(`${dest}.part`), false); // atomic: .part renamed away
    });

    await test('downloadOne resumes from an existing .part via Range', async () => {
        const full = 'ABCDEFGHIJ';
        const dest = path.join(dir, 'resume.bin');
        await writeFile(`${dest}.part`, 'ABCD'); // 4 bytes already present
        let sawRange = null;
        const res = await downloadOne({
            url: 'https://video.twimg.com/resume.mp4',
            dest,
            fetchImpl: async (_url, init) => {
                sawRange = init.headers.range;
                return new Response(Buffer.from(full.slice(4)), { status: 206 }); // remaining 'EFGHIJ'
            },
        });
        assert.equal(sawRange, 'bytes=4-');
        assert.equal(res.ok, true);
        assert.equal(res.resumed, true);
        assert.equal((await readFile(dest)).toString(), full);
    });

    await test('downloadOne retries on 429 then succeeds (no real sleep)', async () => {
        const dest = path.join(dir, 'retry.bin');
        let calls = 0;
        const res = await downloadOne({
            url: 'https://video.twimg.com/retry.mp4',
            dest,
            sleep: async () => {}, // skip the wait
            fetchImpl: async () => {
                calls += 1;
                if (calls === 1) {
                    return new Response('', { status: 429, headers: { 'x-rate-limit-reset': String(Math.floor(Date.now() / 1000)) } });
                }
                return new Response(Buffer.from('ok'), { status: 200 });
            },
        });
        assert.equal(calls, 2);
        assert.equal(res.ok, true);
    });

    await test('downloadOne rejects unsafe hosts before any fetch', async () => {
        let fetched = false;
        const res = await downloadOne({
            url: 'https://evil.com/x.mp4',
            dest: path.join(dir, 'nope.bin'),
            fetchImpl: async () => { fetched = true; return new Response('x'); },
        });
        assert.equal(fetched, false);
        assert.equal(res.ok, false);
        assert.match(res.error, /unsafe media host/);
    });
}
finally {
    await rm(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
