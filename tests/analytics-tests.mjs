// Offline tests for X Analytics range parsing and request construction.
// No network, live auth, account data, or HAR fixtures.
// Run: node tests/analytics-tests.mjs
import assert from 'node:assert/strict';

import {
    ANALYTICS_QUERY_IDS,
    AUDIENCE_METRICS,
    CONTENT_METRICS,
    MEDIA_METRICS,
    buildAnalyticsRequestSpecs,
    resolveAnalyticsRange,
} from '../dist/lib/twitter-client-analytics.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const now = Date.parse('2026-08-19T16:00:00.000Z');

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        passed += 1;
        console.log(`  ok   ${name}`);
    }
    catch (error) {
        failed += 1;
        console.log(`  FAIL ${name}\n       ${error.message}`);
    }
}

console.log('analytics ranges');

await test('defaults to the 28 days ending at now', () => {
    assert.deepEqual(resolveAnalyticsRange({ now }), {
        fromMs: now - (28 * DAY_MS),
        toExclusiveMs: now,
        fromIso: '2026-07-22T16:00:00.000Z',
        toExclusiveIso: '2026-08-19T16:00:00.000Z',
        period: '28d',
    });
});

await test('resolves a 24-hour relative period', () => {
    assert.deepEqual(resolveAnalyticsRange({ period: '24h', now }), {
        fromMs: Date.parse('2026-08-18T16:00:00.000Z'),
        toExclusiveMs: now,
        fromIso: '2026-08-18T16:00:00.000Z',
        toExclusiveIso: '2026-08-19T16:00:00.000Z',
        period: '24h',
    });
});

await test('treats date-only boundaries as inclusive UTC calendar days', () => {
    assert.deepEqual(resolveAnalyticsRange({ from: '2026-08-01', to: '2026-08-19', now }), {
        fromMs: Date.parse('2026-08-01T00:00:00.000Z'),
        toExclusiveMs: Date.parse('2026-08-20T00:00:00.000Z'),
        fromIso: '2026-08-01T00:00:00.000Z',
        toExclusiveIso: '2026-08-20T00:00:00.000Z',
        period: '2026-08-01 to 2026-08-19',
    });
});

await test('preserves full ISO date-time boundaries', () => {
    const from = '2026-08-18T12:34:56.789Z';
    const to = '2026-08-19T15:45:01.123Z';
    const range = resolveAnalyticsRange({ from, to, now });

    assert.equal(range.fromMs, Date.parse(from));
    assert.equal(range.toExclusiveMs, Date.parse(to));
    assert.equal(range.fromIso, from);
    assert.equal(range.toExclusiveIso, to);
    assert.equal(range.period, `${from} to ${to}`);
});

await test('rejects explicit boundaries that are not ISO dates or date-times', () => {
    assert.throws(
        () => resolveAnalyticsRange({ from: 'August 18, 2026', to: '2026-08-19' }),
        /Invalid analytics date boundary/,
    );
});

await test('rejects impossible calendar days in ISO date-times', () => {
    assert.throws(
        () => resolveAnalyticsRange({ from: '2026-02-30T12:00:00Z', to: '2026-03-03T12:00:00Z' }),
        /Invalid analytics date boundary/,
    );
    assert.throws(
        () => resolveAnalyticsRange({ from: '2026-04-31T12:00:00Z', to: '2026-05-02T12:00:00Z' }),
        /Invalid analytics date boundary/,
    );
});

await test('accepts and preserves valid ISO offsets and fractional seconds', () => {
    const from = '2024-02-29T23:59:59.123456+05:30';
    const to = '2024-03-01T00:00:00.654321+05:30';
    const range = resolveAnalyticsRange({ from, to });

    assert.equal(range.fromMs, Date.parse(from));
    assert.equal(range.toExclusiveMs, Date.parse(to));
    assert.equal(range.fromIso, from);
    assert.equal(range.toExclusiveIso, to);
});

await test('rejects mixed period and explicit range options', () => {
    assert.throws(
        () => resolveAnalyticsRange({ period: '24h', from: '2026-08-18', to: '2026-08-19', now }),
        /mutually exclusive/,
    );
});

await test('rejects incomplete explicit ranges', () => {
    assert.throws(() => resolveAnalyticsRange({ from: '2026-08-18', now }), /both --from and --to/);
    assert.throws(() => resolveAnalyticsRange({ to: '2026-08-19', now }), /both --from and --to/);
});

await test('rejects invalid and zero periods', () => {
    assert.throws(() => resolveAnalyticsRange({ period: '0h', now }), /positive/);
    assert.throws(() => resolveAnalyticsRange({ period: 'tomorrow', now }), /Expected/);
    assert.throws(() => resolveAnalyticsRange({ period: '-2d', now }), /Expected/);
});

await test('rejects finite range ends beyond the JavaScript Date boundary', () => {
    assert.throws(
        () => resolveAnalyticsRange({ period: '24h', now: 8_640_000_000_000_001 }),
        /Analytics range end.*supported Date range/,
    );
});

await test('rejects periods whose start falls beyond the JavaScript Date boundary', () => {
    assert.throws(
        () => resolveAnalyticsRange({ period: '100000001d', now: 0 }),
        /Analytics period is too large/,
    );
});

await test('accepts timestamps exactly at both JavaScript Date boundaries', () => {
    const dateLimit = 8_640_000_000_000_000;
    const upperRange = resolveAnalyticsRange({ period: '1h', now: dateLimit });
    const lowerRange = resolveAnalyticsRange({ period: '1h', now: -dateLimit + HOUR_MS });

    assert.equal(upperRange.toExclusiveIso, '+275760-09-13T00:00:00.000Z');
    assert.equal(lowerRange.fromIso, '-271821-04-20T00:00:00.000Z');
});

await test('rejects explicit ranges whose start is not before the end', () => {
    assert.throws(
        () => resolveAnalyticsRange({ from: '2026-08-19T16:00:00.000Z', to: '2026-08-19T16:00:00.000Z' }),
        /before/,
    );
    assert.throws(
        () => resolveAnalyticsRange({ from: '2026-08-20', to: '2026-08-19' }),
        /before/,
    );
});

console.log('analytics request specifications');

await test('exports every observed analytics operation ID and metric allowlist', () => {
    assert.deepEqual(ANALYTICS_QUERY_IDS, {
        accountOverviewDailyQuery: '_P1caq0YB4SVuEtFLPDMfQ',
        audienceOverviewDataQuery: 'H47r_cVD9Uu-qMQLktBCKA',
        contentPageQuery: 'eyqFN-MJHrF7Aq4O5aFBpQ',
        mediaMetricsQuery: 'rLhXZ6PgS37AqskrfVxB1Q',
        videoListProviderQuery: 'J3onn09mCCgjoOo_qNfKuw',
        liveOverviewProviderQuery: 'Yyjk9PyFdDwcmVjRpWP88w',
        spacesOverviewProviderQuery: 'wIGXkaCs_sGftZXvwDLqTg',
    });
    assert.deepEqual(CONTENT_METRICS, [
        'Impressions', 'Likes', 'Engagements', 'Bookmark', 'Share', 'Follows',
        'Replies', 'Retweets', 'ProfileVisits', 'DetailExpands', 'UrlClicks',
        'HashtagClicks', 'PermalinkClicks',
    ]);
    assert.deepEqual(AUDIENCE_METRICS, [
        'Likes', 'Bookmark', 'Impressions', 'Follows', 'Share', 'Replies',
        'Retweets', 'ProfileVisits',
    ]);
    assert.deepEqual(MEDIA_METRICS, [
        'Playback25', 'Playback50', 'Playback75', 'PlaybackComplete',
        'PlaybackStart', 'VideoView', 'WatchTime',
    ]);
});

await test('builds 14 requests spanning all seven operations and metric lists', () => {
    const range = resolveAnalyticsRange({ period: '24h', now });
    const specs = buildAnalyticsRequestSpecs(range);

    assert.equal(specs.length, 14);
    assert.deepEqual(
        [...new Set(specs.map((spec) => spec.operation))].sort(),
        Object.keys(ANALYTICS_QUERY_IDS).sort(),
    );

    const audience = specs.filter((spec) => spec.operation === 'audienceOverviewDataQuery');
    assert.equal(audience.length, AUDIENCE_METRICS.length);
    assert.deepEqual(audience.map((spec) => spec.variables.engagement_type), AUDIENCE_METRICS);

    const content = specs.find((spec) => spec.operation === 'contentPageQuery');
    assert.deepEqual(content.variables.metrics, CONTENT_METRICS);
    assert.equal(content.variables.max_results, 1000);
    assert.equal(content.variables.query_page_size, 100);

    const media = specs.find((spec) => spec.operation === 'mediaMetricsQuery');
    assert.deepEqual(media.variables.metrics, MEDIA_METRICS);
});

await test('uses exact singleton and per-metric audience section labels', () => {
    const specs = buildAnalyticsRequestSpecs(resolveAnalyticsRange({ period: '24h', now }));
    assert.deepEqual(specs.map((spec) => spec.section), [
        'account',
        ...AUDIENCE_METRICS.map((metric) => `audience:${metric}`),
        'content',
        'media',
        'video',
        'live',
        'spaces',
    ]);

    const audienceSections = specs.filter((spec) => spec.section.startsWith('audience:'));
    assert.equal(audienceSections.length, 8);
    assert.deepEqual(
        audienceSections.map((spec) => spec.section.slice('audience:'.length)),
        AUDIENCE_METRICS,
    );
});

await test('computes current, previous, backfill, and inclusive request boundaries', () => {
    const range = resolveAnalyticsRange({ period: '24h', now });
    const specs = buildAnalyticsRequestSpecs(range);
    const account = specs.find((spec) => spec.operation === 'accountOverviewDailyQuery');

    assert.deepEqual(account.variables, {
        current_from: range.fromMs,
        current_from_iso: range.fromIso,
        current_to: range.toExclusiveMs,
        current_to_iso: range.toExclusiveIso,
        prev_from: range.fromMs - DAY_MS,
        prev_from_iso: '2026-08-17T16:00:00.000Z',
        prev_to: range.fromMs,
        prev_to_iso: range.fromIso,
        backfill_from: range.fromMs,
        backfill_to: range.toExclusiveMs,
        show_verified_followers: true,
    });

    const content = specs.find((spec) => spec.operation === 'contentPageQuery');
    assert.equal(content.variables.from, range.fromIso);
    assert.equal(content.variables.to, range.toExclusiveIso);

    for (const spec of specs.filter((item) => !['accountOverviewDailyQuery', 'contentPageQuery'].includes(item.operation))) {
        assert.equal(spec.variables.from, range.fromMs);
        assert.equal(spec.variables.to, range.toExclusiveMs - 1);
    }
});

await test('caps account backfill at the final two days of a longer range', () => {
    const range = resolveAnalyticsRange({ period: '7d', now });
    const account = buildAnalyticsRequestSpecs(range)
        .find((spec) => spec.operation === 'accountOverviewDailyQuery');

    assert.equal(account.variables.backfill_from, range.toExclusiveMs - (2 * DAY_MS));
    assert.equal(account.variables.backfill_to, range.toExclusiveMs);
});

await test('rejects request specs when the previous range is outside the supported Date range', () => {
    const range = resolveAnalyticsRange({ period: '150000000d', now: 8_640_000_000_000_000 });
    assert.throws(
        () => buildAnalyticsRequestSpecs(range),
        /Analytics previous range.*supported Date range/,
    );
});

await test('uses the observed inventory limits and cursor shapes', () => {
    const specs = buildAnalyticsRequestSpecs(resolveAnalyticsRange({ period: '24h', now }));
    const byOperation = Object.fromEntries(specs.map((spec) => [spec.operation, spec]));

    assert.deepEqual(byOperation.videoListProviderQuery.variables, {
        from: now - DAY_MS,
        to: now - 1,
        limit: 30,
        cursor: null,
        estimatedRevenueEnabled: true,
    });
    assert.deepEqual(byOperation.liveOverviewProviderQuery.variables, {
        from: now - DAY_MS,
        to: now - 1,
        limit: 30,
        cursor: { offset: '0' },
    });
    assert.deepEqual(byOperation.spacesOverviewProviderQuery.variables, {
        from: now - DAY_MS,
        to: now - 1,
        limit: 30,
        cursor: null,
    });
});

await test('does not include credentials, authorization, CSRF, or HAR data', () => {
    const specs = buildAnalyticsRequestSpecs(resolveAnalyticsRange({ period: '24h', now }));
    const serialized = JSON.stringify(specs).toLowerCase();

    assert.doesNotMatch(serialized, /cookie|authorization|auth_token|csrf|ct0|\.har/);
    for (const spec of specs) {
        assert.deepEqual(Object.keys(spec).sort(), ['operation', 'section', 'variables']);
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
