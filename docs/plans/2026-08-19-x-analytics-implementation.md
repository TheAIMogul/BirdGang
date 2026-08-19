# X Analytics Command Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a read-only `birdgang analytics` command that reports all observed X Analytics data for a 28-day default window or user-selected relative/explicit range, then produce a live 24-hour report.

**Architecture:** Add pure range/request/response helpers and an analytics mixin to the existing hand-authored `dist/` client. Register a Commander command that reuses BirdGang credential resolution, runs independent analytics GraphQL operations concurrently, preserves partial results, and formats human or JSON output. Treat the HAR only as a development reference; tests use sanitized synthetic fixtures and runtime code never reads it.

**Tech Stack:** Node.js 22 ESM, Commander 14, built-in `fetch`, BirdGang's cookie-authenticated `TwitterClientBase`, `node:assert/strict`, custom `.mjs` offline tests.

---

### Task 1: Add analytics range parsing and request specifications

**Files:**
- Create: `dist/lib/twitter-client-analytics.js`
- Create: `dist/lib/twitter-client-analytics.d.ts`
- Create: `tests/analytics-tests.mjs`

**Step 1: Write failing range tests**

Create `tests/analytics-tests.mjs` with the repository's existing async test
harness and tests covering:

```js
import assert from 'node:assert/strict';
import {
    resolveAnalyticsRange,
    buildAnalyticsRequestSpecs,
} from '../dist/lib/twitter-client-analytics.js';

const now = Date.parse('2026-08-19T16:00:00.000Z');

assert.deepEqual(resolveAnalyticsRange({ period: '24h', now }), {
    fromMs: Date.parse('2026-08-18T16:00:00.000Z'),
    toExclusiveMs: now,
    fromIso: '2026-08-18T16:00:00.000Z',
    toExclusiveIso: '2026-08-19T16:00:00.000Z',
    period: '24h',
});

assert.equal(
    resolveAnalyticsRange({ now }).fromMs,
    now - (28 * 24 * 60 * 60 * 1000),
);

assert.throws(
    () => resolveAnalyticsRange({ period: '24h', from: '2026-08-18', to: '2026-08-19', now }),
    /mutually exclusive/,
);
assert.throws(() => resolveAnalyticsRange({ from: '2026-08-18', now }), /both --from and --to/);
assert.throws(() => resolveAnalyticsRange({ period: '0h', now }), /positive/);
assert.throws(() => resolveAnalyticsRange({ period: 'tomorrow', now }), /Expected/);
```

Also test that date-only boundaries resolve to UTC day boundaries, `to` is
exclusive, and `from < to` is enforced.

**Step 2: Run the test to verify it fails**

Run: `node tests/analytics-tests.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for
`dist/lib/twitter-client-analytics.js`.

**Step 3: Implement minimal range helpers and request constants**

Create `dist/lib/twitter-client-analytics.js` with:

```js
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const PERIOD_RE = /^(\d+)(h|d)$/i;

export const ANALYTICS_QUERY_IDS = Object.freeze({
    accountOverviewDailyQuery: '_P1caq0YB4SVuEtFLPDMfQ',
    audienceOverviewDataQuery: 'H47r_cVD9Uu-qMQLktBCKA',
    contentPageQuery: 'eyqFN-MJHrF7Aq4O5aFBpQ',
    mediaMetricsQuery: 'rLhXZ6PgS37AqskrfVxB1Q',
    videoListProviderQuery: 'J3onn09mCCgjoOo_qNfKuw',
    liveOverviewProviderQuery: 'Yyjk9PyFdDwcmVjRpWP88w',
    spacesOverviewProviderQuery: 'wIGXkaCs_sGftZXvwDLqTg',
});

export const CONTENT_METRICS = Object.freeze([
    'Impressions', 'Likes', 'Engagements', 'Bookmark', 'Share', 'Follows',
    'Replies', 'Retweets', 'ProfileVisits', 'DetailExpands', 'UrlClicks',
    'HashtagClicks', 'PermalinkClicks',
]);

export const AUDIENCE_METRICS = Object.freeze([
    'Likes', 'Bookmark', 'Impressions', 'Follows', 'Share', 'Replies',
    'Retweets', 'ProfileVisits',
]);

export const MEDIA_METRICS = Object.freeze([
    'Playback25', 'Playback50', 'Playback75', 'PlaybackComplete',
    'PlaybackStart', 'VideoView', 'WatchTime',
]);
```

Implement `resolveAnalyticsRange({ period, from, to, now = Date.now() })`:

- Default to `28d` when neither period nor explicit range is supplied.
- Accept positive integer `h` and `d` relative periods.
- Reject mixing `period` with `from`/`to`.
- Require both explicit boundaries.
- Interpret date-only `from` at `00:00:00.000Z` and date-only `to` as the
  next UTC midnight, making the requested final day inclusive to the user.
- Preserve full ISO date-time boundaries exactly.
- Return `fromMs`, `toExclusiveMs`, ISO strings, and a display label.

Implement `buildAnalyticsRequestSpecs(range)` to return one spec for account,
content, media, video, live, and Spaces, plus one audience spec per
`AUDIENCE_METRICS` item. Each spec has `section`, `operation`, and `variables`.
Use the observed query shapes:

```js
{
    current_from: range.fromMs,
    current_from_iso: range.fromIso,
    current_to: range.toExclusiveMs,
    current_to_iso: range.toExclusiveIso,
    prev_from: range.fromMs - duration,
    prev_from_iso: new Date(range.fromMs - duration).toISOString(),
    prev_to: range.fromMs,
    prev_to_iso: range.fromIso,
    backfill_from: Math.max(range.fromMs, range.toExclusiveMs - (2 * DAY_MS)),
    backfill_to: range.toExclusiveMs,
    show_verified_followers: true,
}
```

For endpoints that use inclusive end times, pass `toExclusiveMs - 1`. Content
uses ISO timestamps, `max_results: 1000`, and `query_page_size: 100`. Video,
live, and Spaces use `limit: 30` and the observed cursor shapes.

**Step 4: Add request-spec tests**

Assert that `buildAnalyticsRequestSpecs(range)`:

- Produces 14 requests: six singleton operations plus eight audience calls.
- Includes all seven operation names.
- Requests the complete content, audience, and media metric allowlists.
- Uses only the supplied range and computed previous/backfill ranges.
- Never includes cookie, authorization, CSRF, or HAR fields.

**Step 5: Run tests to verify they pass**

Run: `node tests/analytics-tests.mjs`

Expected: all range and request-spec tests pass.

**Step 6: Add public declarations**

Create `dist/lib/twitter-client-analytics.d.ts` declaring:

```ts
export interface AnalyticsRange {
    fromMs: number;
    toExclusiveMs: number;
    fromIso: string;
    toExclusiveIso: string;
    period: string;
}
export interface AnalyticsRangeOptions {
    period?: string;
    from?: string;
    to?: string;
    now?: number;
}
export declare function resolveAnalyticsRange(options?: AnalyticsRangeOptions): AnalyticsRange;
export declare function buildAnalyticsRequestSpecs(range: AnalyticsRange): AnalyticsRequestSpec[];
```

Also declare the operation constants and placeholder analytics result/client
interfaces that later tasks will complete.

**Step 7: Commit**

```bash
git add dist/lib/twitter-client-analytics.js dist/lib/twitter-client-analytics.d.ts tests/analytics-tests.mjs
git commit -m "v1.1.0: add analytics request builders"
```

### Task 2: Implement response normalization and human summaries

**Files:**
- Modify: `dist/lib/twitter-client-analytics.js`
- Modify: `dist/lib/twitter-client-analytics.d.ts`
- Modify: `tests/analytics-tests.mjs`

**Step 1: Write failing normalization tests**

Add sanitized synthetic fixtures for each observed response shape. Use only
invented IDs/text/counts. Cover:

```js
const accountPayload = {
    data: { viewer_v2: { user_results: { result: {
        relationship_counts: { followers: 120 },
        verified_follower_count: 7,
        current_time_series: [
            { timestamp: 1787097600000, engagement_type: 'Impressions', count: 900 },
        ],
    } } } },
};

const contentPayload = {
    data: { viewer_v2: { user_results: { result: {
        tweets_results: [{ result: {
            rest_id: '100',
            details: { full_text: 'Synthetic post', created_at_ms: 1787097600000 },
            organic_metrics_total: [
                { metric_type: 'Impressions', metric_value: 500 },
                { metric_type: 'Engagements', metric_value: 25 },
            ],
        } }],
    } } } },
};
```

Test exported helpers `unwrapAnalyticsResult(payload)`,
`metricArrayToObject(values)`, `normalizeAnalyticsSection(spec, payload)`, and
`summarizeAnalyticsReport(report)`.

Expected normalization:

- Remove GraphQL viewer wrappers while preserving all analytics fields.
- Convert metric arrays to keyed numeric objects where useful.
- Preserve source metric names and per-day/per-post rows.
- Keep empty live/Spaces responses as valid empty sections.
- Throw a sanitized error for missing viewer results or GraphQL errors.
- Human summary includes range, follower totals, aggregate account metrics,
  top content rows, audience highlights, media/watch-time totals, and explicit
  `No data` labels without printing raw JSON.

**Step 2: Run tests to verify they fail**

Run: `node tests/analytics-tests.mjs`

Expected: FAIL because normalization helpers are undefined.

**Step 3: Implement normalization helpers**

Add pure exported functions:

```js
export function unwrapAnalyticsResult(payload) {
    const errors = Array.isArray(payload?.errors) ? payload.errors : [];
    if (errors.length > 0) {
        throw new Error(errors.map((error) => error?.message || 'GraphQL error').join(', '));
    }
    const result = payload?.data?.viewer_v2?.user_results?.result;
    if (!result || typeof result !== 'object') {
        throw new Error('X Analytics response did not include an authenticated user result');
    }
    return result;
}

export function metricArrayToObject(values) {
    const output = {};
    for (const item of Array.isArray(values) ? values : []) {
        if (typeof item?.metric_type !== 'string') continue;
        const value = Number(item.metric_value);
        if (Number.isFinite(value)) output[item.metric_type] = value;
    }
    return output;
}
```

Implement operation-specific normalization without dropping unknown fields.
Each normalized section includes `{ ok: true, operation, data }`; audience
responses also include their requested metric. Implement summary aggregation
from normalized values, never from HAR-specific paths.

**Step 4: Run tests to verify they pass**

Run: `node tests/analytics-tests.mjs`

Expected: all range, request, normalization, and summary tests pass.

**Step 5: Complete declarations**

Declare normalized section/report types, partial failures, and all exported
helpers in `dist/lib/twitter-client-analytics.d.ts`.

**Step 6: Commit**

```bash
git add dist/lib/twitter-client-analytics.js dist/lib/twitter-client-analytics.d.ts tests/analytics-tests.mjs
git commit -m "v1.1.0: normalize X analytics responses"
```

### Task 3: Add the authenticated analytics client mixin

**Files:**
- Modify: `dist/lib/twitter-client-analytics.js`
- Modify: `dist/lib/twitter-client-analytics.d.ts`
- Modify: `dist/lib/twitter-client.js`
- Modify: `dist/lib/twitter-client.d.ts`
- Modify: `dist/lib/index.d.ts`
- Modify: `dist/lib/query-ids.json`
- Modify: `dist/lib/twitter-client-constants.js`
- Modify: `tests/analytics-tests.mjs`

**Step 1: Write failing client tests with injected fetch**

Instantiate `TwitterClient` with synthetic cookies and replace
`globalThis.fetch` inside a `try/finally`. Return synthetic JSON by operation
name. Assert:

- Requests are GETs under `https://x.com/i/api/graphql/<id>/<operation>`.
- Headers reuse the client's cookie and CSRF values.
- All specs execute and produce a complete report.
- One failed endpoint yields `partial: true` and preserves other sections.
- All failed endpoints return `{ success: false }` with sanitized errors.
- HTTP bodies, request headers, cookies, and tokens never appear in errors.
- A 404 triggers the existing query-ID refresh path and retries once.

**Step 2: Run tests to verify they fail**

Run: `node tests/analytics-tests.mjs`

Expected: FAIL because `TwitterClient#getAnalytics()` does not exist.

**Step 3: Implement the mixin**

Export `withAnalytics(Base)` and add:

```js
async getAnalytics(options = {}) {
    const range = resolveAnalyticsRange(options);
    const specs = buildAnalyticsRequestSpecs(range);
    await this.ensureClientUserId();
    const settled = await Promise.all(specs.map((spec) => this.fetchAnalyticsSpec(spec)));
    const sections = mergeAnalyticsSections(settled);
    const successful = Object.values(sections).filter((section) => section.ok).length;
    const total = Object.keys(sections).length;
    if (successful === 0) {
        return { success: false, error: 'All X Analytics requests failed', range, sections };
    }
    return {
        success: true,
        partial: successful < total,
        generatedAt: new Date().toISOString(),
        range,
        sections,
    };
}
```

`fetchAnalyticsSpec()` must resolve the query ID through `getQueryId()`, fall
back to `ANALYTICS_QUERY_IDS`, call `fetchWithTimeout()` with `getJsonHeaders()`,
parse only JSON, sanitize HTTP/GraphQL errors, and use
`withRefreshedQueryIdsOn404()`.

**Step 4: Register query IDs**

Add the seven operation IDs to `dist/lib/query-ids.json` and
`FALLBACK_QUERY_IDS` in `dist/lib/twitter-client-constants.js`. This includes
them automatically in `TARGET_QUERY_ID_OPERATIONS` for self-healing discovery.

**Step 5: Compose and type the mixin**

Import `withAnalytics` in `dist/lib/twitter-client.js` and compose it around
the existing mixed client. Add `TwitterClientAnalyticsMethods` to the
intersection in `dist/lib/twitter-client.d.ts`, export analytics public types,
and re-export them from `dist/lib/index.d.ts`.

**Step 6: Run tests to verify they pass**

Run: `node tests/analytics-tests.mjs`

Expected: all tests pass with no network access.

**Step 7: Commit**

```bash
git add dist/lib/twitter-client-analytics.js dist/lib/twitter-client-analytics.d.ts dist/lib/twitter-client.js dist/lib/twitter-client.d.ts dist/lib/index.d.ts dist/lib/query-ids.json dist/lib/twitter-client-constants.js tests/analytics-tests.mjs
git commit -m "v1.1.0: fetch authenticated X analytics"
```

### Task 4: Add and wire the `analytics` CLI command

**Files:**
- Create: `dist/commands/analytics.js`
- Create: `dist/commands/analytics.d.ts`
- Modify: `dist/cli/program.js`
- Modify: `tests/analytics-tests.mjs`

**Step 1: Write failing command tests**

Export a pure `validateAnalyticsCommandOptions(options, now)` helper from the
command module. Test:

- No options resolves the 28-day range.
- `--period 24h` resolves a rolling 24-hour range.
- `--from` and `--to` resolve an explicit range.
- Mixed or incomplete range options throw actionable messages.

Spawn `node dist/cli.js analytics --help` and assert the help contains
`--period`, `--from`, `--to`, and `--json` without performing network access.

**Step 2: Run tests to verify they fail**

Run: `node tests/analytics-tests.mjs`

Expected: FAIL because the command module and CLI registration do not exist.

**Step 3: Implement the command**

Create `registerAnalyticsCommand(program, ctx)` following existing credential
and timeout patterns:

```js
program
    .command('analytics')
    .description('Get authenticated X account analytics')
    .option('--period <duration>', 'Relative reporting period, such as 24h, 7d, or 28d')
    .option('--from <date>', 'Reporting range start (ISO date or date-time)')
    .option('--to <date>', 'Reporting range end (ISO date or date-time)')
    .option('--json', 'Output the complete report as JSON')
    .action(async (cmdOpts) => { /* resolve credentials, call getAnalytics, print */ });
```

Use `console.log(JSON.stringify(result, null, 2))` for JSON. For human output,
print `summarizeAnalyticsReport(result)`. Print partial-section warnings to
stderr but keep exit status zero when at least one section succeeds. Exit
nonzero for invalid ranges, missing credentials, or total analytics failure.

**Step 4: Register the command**

Import `registerAnalyticsCommand` in `dist/cli/program.js`, add `analytics` to
`KNOWN_COMMANDS`, call the register function, update the command description,
add `birdgang analytics --period 24h` to examples, and include analytics in the
JSON-output help text.

**Step 5: Run command and regression tests**

Run:

```bash
node tests/analytics-tests.mjs
node tests/feature-tests.mjs
node dist/cli.js analytics --help
node dist/cli.js --help
```

Expected: tests pass and both help screens include analytics without errors.

**Step 6: Commit**

```bash
git add dist/commands/analytics.js dist/commands/analytics.d.ts dist/cli/program.js tests/analytics-tests.mjs
git commit -m "v1.1.0: add BirdGang analytics command"
```

### Task 5: Document, version, and make the project test command authoritative

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `package.json`

**Step 1: Update documentation**

Add an Analytics section to `README.md` showing:

```bash
birdgang analytics                    # last 28 days
birdgang analytics --period 24h       # rolling 24 hours
birdgang analytics --from 2026-08-01 --to 2026-08-19
birdgang analytics --period 7d --json
```

Document all report sections, partial results, read-only behavior, and that
analytics availability depends on the authenticated X account. Add the command
to the command table and JSON-output list. Do not mention the HAR or include
real account values.

**Step 2: Update package metadata**

Set package version to `1.1.0`, include analytics in the description, and make
the shipped test script match the dist-only repository:

```json
"test": "node tests/feature-tests.mjs && node tests/analytics-tests.mjs"
```

Do not repair stale `src/` build scripts in this feature; that is separate
repository maintenance.

**Step 3: Update changelog**

Add a `1.1.0` entry describing the authenticated analytics command, ranges,
JSON output, partial failure behavior, and HAR-free runtime implementation.

**Step 4: Run documentation and metadata checks**

Run:

```bash
npm test
node dist/cli.js --version
node dist/cli.js analytics --help
git diff --check
```

Expected: all tests pass, version is `1.1.0`, help is correct, and diff check
is clean.

**Step 5: Commit**

```bash
git add README.md CHANGELOG.md package.json
git commit -m "v1.1.0: document X analytics support"
```

### Task 6: Run full verification and generate the live 24-hour report

**Files:**
- No code changes expected
- Optional private output outside Git: `/tmp/birdgang-analytics-24h.json`

**Step 1: Run the full offline suite**

Run:

```bash
npm test
node dist/cli.js --help
node dist/cli.js analytics --help
git diff --check
git status -sb
```

Expected: all tests pass, command help is registered, no uncommitted HAR or
credential files exist, and only intentional feature commits differ from the
base branch.

**Step 2: Run a live read-only 24-hour JSON report**

Run with network access:

```bash
node dist/cli.js analytics --period 24h --json
```

Capture output only to a temporary path when needed for parsing. Never put the
report in the repository or logs that expose credentials. The JSON output must
not contain request headers, cookies, `auth_token`, `ct0`, bearer tokens, or
CSRF values.

**Step 3: Validate the live report**

Confirm:

- The authenticated account is the expected BirdGang account.
- The range is exactly the preceding 24 hours.
- At least one analytics section succeeds.
- Partial failures, if any, are reported by section.
- Human output and JSON totals agree.
- No credentials appear in output.

**Step 4: Run the human report**

Run:

```bash
node dist/cli.js analytics --period 24h
```

Expected: a readable summary containing all successful analytics sections.

**Step 5: Review the complete diff and history**

Run:

```bash
git diff --stat HEAD~5..HEAD
git log --oneline --decorate -8
git status -sb
```

Expected: focused analytics changes, no HAR, no secrets, and a clean worktree.

