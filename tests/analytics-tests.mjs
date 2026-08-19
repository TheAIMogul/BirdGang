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
    metricArrayToObject,
    normalizeAnalyticsSection,
    resolveAnalyticsRange,
    summarizeAnalyticsReport,
    unwrapAnalyticsResult,
} from '../dist/lib/twitter-client-analytics.js';
import { FALLBACK_QUERY_IDS, TARGET_QUERY_ID_OPERATIONS } from '../dist/lib/twitter-client-constants.js';
import { TwitterClient } from '../dist/lib/twitter-client.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const now = Date.parse('2026-08-19T16:00:00.000Z');

const accountPayload = {
    data: { viewer_v2: { user_results: { result: {
        user_id: 'synthetic-user-42',
        screen_name: 'synthetic_account',
        name: 'Synthetic Account',
        relationship_counts: { followers: 120, following: 45 },
        verified_follower_count: 7,
        current_time_series: [
            { timestamp: 1787097600000, engagement_type: 'Impressions', count: 900 },
            { timestamp: 1787097600000, engagement_type: 'Likes', count: 45 },
        ],
        previous_time_series: [
            { timestamp: 1787011200000, engagement_type: 'Impressions', count: 700 },
        ],
        follow_metrics: { follows: 11, unfollows: 2 },
        invented_account_field: { retained: true },
    } } } },
};

const audiencePayload = {
    data: { viewer_v2: { user_results: { result: {
        organic_time_series: [
            { timestamp: 1787097600000, metric_value: 30 },
        ],
        demographic_rows: [
            { dimension: 'age', value: '25-34', count: 18 },
            { dimension: 'language', value: 'en', count: 15 },
        ],
        country_rows: [
            { country_code: 'XZ', country_name: 'Exampleland', count: 20 },
        ],
        invented_audience_field: 'retained',
    } } } },
};

const contentPayload = {
    data: { viewer_v2: { user_results: { result: {
        tweets_results: [{ result: {
            rest_id: 'synthetic-post-100',
            details: {
                full_text: 'Synthetic launch note',
                created_at_ms: 1787097600000,
                media: [{ media_key: 'synthetic-media-100', type: 'video' }],
            },
            organic_metrics_total: [
                { metric_type: 'Impressions', metric_value: 500 },
                { metric_type: 'Engagements', metric_value: 25 },
                { metric_type: 'Likes', metric_value: 19 },
            ],
            invented_post_field: 'retained',
        } }],
        next_cursor: 'synthetic-content-cursor',
        invented_content_field: 'retained',
    } } } },
};

const mediaPayload = {
    data: { viewer_v2: { user_results: { result: {
        metric_time_series: [
            {
                timestamp: 1787097600000,
                metric_values: [
                    { metric_type: 'VideoView', metric_value: 64 },
                    { metric_type: 'WatchTime', metric_value: 900 },
                ],
            },
            { timestamp: 1787101200000, metric_type: 'PlaybackComplete', metric_value: 12 },
        ],
        invented_media_field: 'retained',
    } } } },
};

const videoPayload = {
    data: { viewer_v2: { user_results: { result: {
        cursor: { value: 'synthetic-video-cursor', has_next_page: false },
        media_results: [{
            media_id: 'synthetic-video-200',
            title: 'Synthetic clip',
            duration_ms: 10000,
            metrics: [
                { metric_type: 'VideoView', metric_value: 44 },
                { metric_type: 'WatchTime', metric_value: 600 },
            ],
        }],
        estimated_revenue: { amount: 1.23, currency: 'USD' },
        invented_video_field: 'retained',
    } } } },
};

const livePayload = {
    data: { viewer_v2: { user_results: { result: {
        live_results: [],
        cursor: { offset: '0' },
        invented_live_field: 'retained',
    } } } },
};

const spacesPayload = {
    data: { viewer_v2: { user_results: { result: {
        spaces_results: [],
        cursor: null,
        invented_spaces_field: 'retained',
    } } } },
};

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
    for (const [operation, queryId] of Object.entries(ANALYTICS_QUERY_IDS)) {
        assert.equal(FALLBACK_QUERY_IDS[operation], queryId);
        assert.ok(TARGET_QUERY_ID_OPERATIONS.includes(operation));
    }
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

console.log('analytics response helpers');

await test('unwraps the authenticated viewer result without cloning it', () => {
    const result = { relationship_counts: { followers: 321 }, invented_field: 'retained' };
    const payload = { data: { viewer_v2: { user_results: { result } } } };

    assert.equal(unwrapAnalyticsResult(payload), result);
});

await test('rejects missing or non-object authenticated viewer results', () => {
    const expected = /X Analytics response did not include an authenticated user result/;

    assert.throws(() => unwrapAnalyticsResult({}), expected);
    assert.throws(
        () => unwrapAnalyticsResult({ data: { viewer_v2: { user_results: { result: 'invalid' } } } }),
        expected,
    );
});

await test('turns GraphQL errors into sanitized messages', () => {
    const secret = 'synthetic-secret-value';
    assert.throws(
        () => unwrapAnalyticsResult({
            errors: [
                { message: `Denied auth_token=${secret}` },
                { message: `Request x-csrf-token: ${secret}` },
                {},
            ],
        }),
        (error) => {
            assert.match(error.message, /Denied auth_token=\[REDACTED\]/);
            assert.match(error.message, /Request x-csrf-token: \[REDACTED\]/);
            assert.match(error.message, /GraphQL error/);
            assert.doesNotMatch(error.message, new RegExp(secret));
            return true;
        },
    );
});

await test('redacts credentials embedded in JSON-shaped GraphQL messages', () => {
    const secret = 'synthetic-json-secret';

    assert.throws(
        () => unwrapAnalyticsResult({
            errors: [{ message: `Rejected {"ct0":"${secret}","authorization":"Bearer ${secret}"}` }],
        }),
        (error) => {
            assert.doesNotMatch(error.message, new RegExp(secret));
            assert.match(error.message, /\[REDACTED\]/);
            return true;
        },
    );
});

await test('redacts complete unquoted bearer credentials without consuming following text', () => {
    const secret = 'synthetic-unquoted-secret';
    const cases = [
        {
            input: `Denied Authorization: Bearer ${secret}; retry after validation`,
            expected: 'Denied Authorization: [REDACTED]; retry after validation',
        },
        {
            input: `Denied authorization=bearer ${secret}, request remains read-only`,
            expected: 'Denied authorization=[REDACTED], request remains read-only',
        },
    ];

    for (const { input, expected } of cases) {
        assert.throws(
            () => unwrapAnalyticsResult({ errors: [{ message: input }] }),
            (error) => {
                assert.equal(error.message, expected);
                assert.doesNotMatch(error.message, new RegExp(secret));
                return true;
            },
        );
    }
});

await test('redacts quoted bearer credentials in GraphQL errors across casing variants', () => {
    const cases = [
        {
            secret: 'synthetic-double-quoted-secret',
            input: 'Denied Authorization: Bearer "synthetic-double-quoted-secret"; double suffix retained',
            expected: 'Denied Authorization: [REDACTED]; double suffix retained',
        },
        {
            secret: 'synthetic-single-quoted-secret',
            input: "Denied aUtHoRiZaTiOn=bEaReR 'synthetic-single-quoted-secret', single suffix retained",
            expected: 'Denied aUtHoRiZaTiOn=[REDACTED], single suffix retained',
        },
        {
            secret: 'synthetic-standalone-double-secret',
            input: 'Standalone bEaReR "synthetic-standalone-double-secret"; explanation retained',
            expected: 'Standalone Bearer [REDACTED]; explanation retained',
        },
        {
            secret: 'synthetic-standalone-single-secret',
            input: "Standalone BEARER 'synthetic-standalone-single-secret', detail retained",
            expected: 'Standalone Bearer [REDACTED], detail retained',
        },
    ];

    for (const { secret, input, expected } of cases) {
        assert.throws(
            () => unwrapAnalyticsResult({ errors: [{ message: input }] }),
            (error) => {
                assert.equal(error.message, expected);
                assert.doesNotMatch(error.message, new RegExp(secret));
                return true;
            },
        );
    }
});

await test('converts finite metric pairs without changing the input', () => {
    const values = [
        { metric_type: 'Impressions', metric_value: 450 },
        { metric_type: 'Engagements', metric_value: '22' },
        { metric_type: 'WatchTime', metric_value: 0 },
    ];
    const snapshot = structuredClone(values);

    assert.deepEqual(metricArrayToObject(values), {
        Impressions: 450,
        Engagements: 22,
        WatchTime: 0,
    });
    assert.deepEqual(values, snapshot);
});

await test('ignores malformed metric entries safely', () => {
    assert.deepEqual(metricArrayToObject([
        null,
        { metric_type: '', metric_value: 12 },
        { metric_type: 'Missing' },
        { metric_type: 'Infinite', metric_value: Infinity },
        { metric_type: 42, metric_value: 3 },
        { metric_type: 'Nested', metric_value: {} },
    ]), {});
    assert.deepEqual(metricArrayToObject(null), {});
});

console.log('analytics response normalization');

await test('normalizes account totals and time series while preserving source fields', () => {
    const spec = { section: 'account', operation: 'accountOverviewDailyQuery', variables: {} };
    const snapshot = structuredClone(accountPayload);
    const section = normalizeAnalyticsSection(spec, accountPayload);

    assert.equal(section.ok, true);
    assert.equal(section.section, 'account');
    assert.equal(section.operation, 'accountOverviewDailyQuery');
    assert.equal(section.data.followers, 120);
    assert.equal(section.data.verifiedFollowers, 7);
    assert.equal(section.data.timeSeries, section.data.current_time_series);
    assert.equal(section.data.followMetrics, section.data.follow_metrics);
    assert.deepEqual(section.data.metricTotals, { Impressions: 900, Likes: 45 });
    assert.deepEqual(section.data.relationship_counts, { followers: 120, following: 45 });
    assert.deepEqual(section.data.previous_time_series, accountPayload.data.viewer_v2.user_results.result.previous_time_series);
    assert.deepEqual(section.data.invented_account_field, { retained: true });
    assert.deepEqual(accountPayload, snapshot);
});

await test('normalizes content posts with identity, text, media, and source metrics', () => {
    const spec = { section: 'content', operation: 'contentPageQuery', variables: {} };
    const section = normalizeAnalyticsSection(spec, contentPayload);
    const post = section.data.posts[0];

    assert.equal(section.section, 'content');
    assert.equal(post.id, 'synthetic-post-100');
    assert.equal(post.text, 'Synthetic launch note');
    assert.equal(post.createdAt, 1787097600000);
    assert.deepEqual(post.media, [{ media_key: 'synthetic-media-100', type: 'video' }]);
    assert.deepEqual(post.metricTotals, { Impressions: 500, Engagements: 25, Likes: 19 });
    assert.equal(post.invented_post_field, 'retained');
    assert.equal(section.data.invented_content_field, 'retained');
    assert.equal(section.data.next_cursor, 'synthetic-content-cursor');
});

await test('normalizes content with missing optional post details', () => {
    const spec = { section: 'content', operation: 'contentPageQuery', variables: {} };
    const payload = {
        data: { viewer_v2: { user_results: { result: {
            tweets_results: [{ result: { id: 'synthetic-minimal-post' } }, null, {}],
        } } } },
    };
    const section = normalizeAnalyticsSection(spec, payload);

    assert.deepEqual(section.data.posts, [{
        id: 'synthetic-minimal-post',
        text: '',
        createdAt: null,
        media: [],
        metricTotals: {},
    }]);
});

await test('preserves source metric collections while deriving collision-free totals', () => {
    const sourceMetrics = [{
        metric_type: 'Impressions',
        metric_value: 77,
        vendor_metadata: { synthetic_vendor_flag: true },
    }];
    const content = normalizeAnalyticsSection(
        { section: 'content', operation: 'contentPageQuery', variables: {} },
        { data: { viewer_v2: { user_results: { result: {
            tweets_results: [{ result: {
                rest_id: 'synthetic-metric-collision-post',
                metrics: sourceMetrics,
                invented_post_field: 'retained',
            } }],
        } } } } },
    );
    const account = normalizeAnalyticsSection(
        { section: 'account', operation: 'accountOverviewDailyQuery', variables: {} },
        { data: { viewer_v2: { user_results: { result: {
            metrics: sourceMetrics,
            current_time_series: [{ engagement_type: 'Likes', count: 6 }],
        } } } } },
    );
    const media = normalizeAnalyticsSection(
        { section: 'media', operation: 'mediaMetricsQuery', variables: {} },
        { data: { viewer_v2: { user_results: { result: {
            metrics: sourceMetrics,
            metric_time_series: [{ metric_type: 'VideoView', metric_value: 9 }],
        } } } } },
    );
    const video = normalizeAnalyticsSection(
        { section: 'video', operation: 'videoListProviderQuery', variables: {} },
        { data: { viewer_v2: { user_results: { result: {
            metrics: sourceMetrics,
            media_results: [{ media_id: 'synthetic-collision-video', metrics: sourceMetrics }],
        } } } } },
    );

    assert.equal(content.data.posts[0].metrics, sourceMetrics);
    assert.deepEqual(content.data.posts[0].metrics[0].vendor_metadata, { synthetic_vendor_flag: true });
    assert.deepEqual(content.data.posts[0].metricTotals, { Impressions: 77 });
    assert.equal(content.data.posts[0].invented_post_field, 'retained');

    assert.equal(account.data.metrics, sourceMetrics);
    assert.deepEqual(account.data.metricTotals, { Likes: 6 });
    assert.equal(media.data.metrics, sourceMetrics);
    assert.deepEqual(media.data.metricTotals, { VideoView: 9 });
    assert.equal(video.data.metrics, sourceMetrics);
    assert.equal(video.data.mediaInventory[0].metrics, sourceMetrics);
    assert.deepEqual(video.data.metricTotals, { Impressions: 77 });
});

await test('normalizes audience metric, organic series, demographics, and countries', () => {
    const spec = {
        section: 'audience:Likes',
        operation: 'audienceOverviewDataQuery',
        variables: { engagement_type: 'Likes' },
    };
    const section = normalizeAnalyticsSection(spec, audiencePayload);

    assert.equal(section.section, 'audience:Likes');
    assert.equal(section.metric, 'Likes');
    assert.equal(section.data.requestedMetric, 'Likes');
    assert.deepEqual(section.data.organicTimeSeries, audiencePayload.data.viewer_v2.user_results.result.organic_time_series);
    assert.deepEqual(section.data.demographics, audiencePayload.data.viewer_v2.user_results.result.demographic_rows);
    assert.deepEqual(section.data.countries, audiencePayload.data.viewer_v2.user_results.result.country_rows);
    assert.equal(section.data.invented_audience_field, 'retained');
});

await test('normalizes media time-series totals and retains every row', () => {
    const spec = { section: 'media', operation: 'mediaMetricsQuery', variables: {} };
    const section = normalizeAnalyticsSection(spec, mediaPayload);

    assert.equal(section.section, 'media');
    assert.deepEqual(section.data.metricTimeSeries, mediaPayload.data.viewer_v2.user_results.result.metric_time_series);
    assert.deepEqual(section.data.metricTotals, {
        VideoView: 64,
        WatchTime: 900,
        PlaybackComplete: 12,
    });
    assert.equal(section.data.invented_media_field, 'retained');
});

await test('normalizes video cursor and media inventory without dropping source data', () => {
    const spec = { section: 'video', operation: 'videoListProviderQuery', variables: {} };
    const section = normalizeAnalyticsSection(spec, videoPayload);

    assert.equal(section.section, 'video');
    assert.deepEqual(section.data.cursor, { value: 'synthetic-video-cursor', has_next_page: false });
    assert.equal(section.data.mediaInventory, section.data.media_results);
    assert.equal(section.data.mediaInventory[0].media_id, 'synthetic-video-200');
    assert.deepEqual(section.data.metricTotals, { VideoView: 44, WatchTime: 600 });
    assert.deepEqual(section.data.estimated_revenue, { amount: 1.23, currency: 'USD' });
    assert.equal(section.data.invented_video_field, 'retained');
});

await test('accepts empty authenticated live and Spaces result arrays', () => {
    const live = normalizeAnalyticsSection(
        { section: 'live', operation: 'liveOverviewProviderQuery', variables: {} },
        livePayload,
    );
    const spaces = normalizeAnalyticsSection(
        { section: 'spaces', operation: 'spacesOverviewProviderQuery', variables: {} },
        spacesPayload,
    );

    assert.deepEqual(live.data.live_results, []);
    assert.deepEqual(live.data.cursor, { offset: '0' });
    assert.equal(live.data.invented_live_field, 'retained');
    assert.deepEqual(spaces.data.spaces_results, []);
    assert.equal(spaces.data.cursor, null);
    assert.equal(spaces.data.invented_spaces_field, 'retained');
});

await test('accepts a completely empty authenticated result for every operation', () => {
    const emptyPayload = { data: { viewer_v2: { user_results: { result: {} } } } };

    for (const operation of Object.keys(ANALYTICS_QUERY_IDS)) {
        const section = normalizeAnalyticsSection({ section: `empty:${operation}`, operation, variables: {} }, emptyPayload);
        assert.equal(section.ok, true);
        assert.equal(section.operation, operation);
    }
});

await test('propagates sanitized GraphQL and missing-viewer errors during normalization', () => {
    const spec = { section: 'account', operation: 'accountOverviewDailyQuery', variables: {} };

    assert.throws(
        () => normalizeAnalyticsSection(spec, { errors: [{ message: 'Synthetic analytics denial' }] }),
        /Synthetic analytics denial/,
    );
    assert.throws(() => normalizeAnalyticsSection(spec, { data: {} }), /authenticated user result/);
});

await test('all seven operation fixtures are synthetic and secret-free', () => {
    const serialized = JSON.stringify([
        accountPayload,
        audiencePayload,
        contentPayload,
        mediaPayload,
        videoPayload,
        livePayload,
        spacesPayload,
    ]).toLowerCase();

    assert.doesNotMatch(serialized, /auth_token|x-csrf-token|\bct0\b|authorization|cookie|\.har/);
    assert.match(serialized, /synthetic/);
});

console.log('authenticated analytics client');

const syntheticCookies = Object.freeze({
    authToken: 'synthetic-auth-value',
    ct0: 'synthetic-csrf-value',
    cookieHeader: 'auth_token=synthetic-auth-value; ct0=synthetic-csrf-value',
});

function createSyntheticClient() {
    return new TwitterClient({ cookies: syntheticCookies });
}

function payloadForAnalyticsOperation(operation) {
    const payloads = {
        accountOverviewDailyQuery: accountPayload,
        audienceOverviewDataQuery: audiencePayload,
        contentPageQuery: contentPayload,
        mediaMetricsQuery: mediaPayload,
        videoListProviderQuery: videoPayload,
        liveOverviewProviderQuery: livePayload,
        spacesOverviewProviderQuery: spacesPayload,
    };
    return structuredClone(payloads[operation]);
}

function parseAnalyticsUrl(input) {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://x.com');
    assert.deepEqual([...url.searchParams.keys()], ['variables']);
    const parts = url.pathname.split('/');
    assert.equal(parts.length, 6);
    assert.deepEqual(parts.slice(0, 4), ['', 'i', 'api', 'graphql']);
    const queryId = parts[4];
    const operation = parts[5];
    assert.equal(ANALYTICS_QUERY_IDS[operation], queryId);
    assert.match(queryId, /^[A-Za-z0-9_-]+$/);
    return {
        queryId,
        operation,
        variables: JSON.parse(url.searchParams.get('variables')),
    };
}

function syntheticJsonResponse(payload, status = 200, statusText = '') {
    return new Response(JSON.stringify(payload), {
        status,
        statusText,
        headers: { 'content-type': 'application/json' },
    });
}

async function withStubbedFetch(fetchStub, callback) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchStub;
    try {
        return await callback();
    }
    finally {
        globalThis.fetch = originalFetch;
        assert.equal(globalThis.fetch, originalFetch);
    }
}

function configureOfflineAnalyticsClient(client) {
    let ensureCalls = 0;
    client.clientUserId = 'synthetic-user-42';
    client.ensureClientUserId = async () => {
        ensureCalls += 1;
    };
    client.getQueryId = async (operation) => ANALYTICS_QUERY_IDS[operation];
    return { get ensureCalls() { return ensureCalls; } };
}

await test('fetches all 14 allowlisted analytics requests concurrently with authenticated JSON headers', async () => {
    const client = createSyntheticClient();
    const clientState = configureOfflineAnalyticsClient(client);
    const calls = [];
    let firstResponseCallCount;

    const report = await withStubbedFetch(async (url, init) => {
        const parsed = parseAnalyticsUrl(url);
        calls.push({ parsed, init });
        await Promise.resolve();
        firstResponseCallCount ??= calls.length;
        return syntheticJsonResponse(payloadForAnalyticsOperation(parsed.operation));
    }, () => client.getAnalytics({ period: '24h', now }));

    assert.equal(clientState.ensureCalls, 1);
    assert.equal(calls.length, 14);
    assert.equal(firstResponseCallCount, 14);
    assert.equal(new Set(calls.map(({ parsed }) => parsed.operation === 'audienceOverviewDataQuery'
        ? `${parsed.operation}:${parsed.variables.engagement_type}`
        : parsed.operation)).size, 14);

    for (const { init } of calls) {
        assert.equal(init.method, 'GET');
        assert.equal(init.redirect, 'error');
        assert.equal(init.headers.cookie, syntheticCookies.cookieHeader);
        assert.equal(init.headers['x-csrf-token'], syntheticCookies.ct0);
        assert.match(init.headers.authorization, /^Bearer A{10,}/);
        assert.equal(init.headers['content-type'], 'application/json');
    }

    assert.equal(report.success, true);
    assert.equal(report.partial, false);
    assert.equal(report.generatedAt, '2026-08-19T16:00:00.000Z');
    assert.equal(report.range.period, '24h');
    assert.deepEqual(report.account, {
        id: 'synthetic-user-42',
        username: 'synthetic_account',
        name: 'Synthetic Account',
    });
    assert.deepEqual(Object.keys(report.sections), [
        'account', 'audience', 'content', 'media', 'video', 'live', 'spaces',
    ]);
    assert.equal(report.sections.audience.ok, true);
    assert.equal(report.sections.audience.partial, false);
    assert.deepEqual(Object.keys(report.sections.audience.metrics), AUDIENCE_METRICS);
    assert.ok(Object.values(report.sections.audience.metrics).every((metric) => metric.ok));
    assert.deepEqual(report.sectionCounts, { total: 7, succeeded: 7, failed: 0 });
    assert.deepEqual(report.requestCounts, { total: 14, succeeded: 14, failed: 0 });
    assert.match(summarizeAnalyticsReport(report), /Audience highlights:.*Likes 30/);

    const serialized = JSON.stringify(report);
    assert.doesNotMatch(serialized, /synthetic-auth-value|synthetic-csrf-value/);
    assert.doesNotMatch(serialized, /authorization|x-csrf-token|cookieHeader/i);
});

await test('preserves successful sections and sanitized failures in a partial report', async () => {
    const client = createSyntheticClient();
    configureOfflineAnalyticsClient(client);
    const rawBodySecret = 'synthetic-http-body-secret';

    const report = await withStubbedFetch(async (url) => {
        const { operation } = parseAnalyticsUrl(url);
        if (operation === 'contentPageQuery') {
            return new Response(`raw response auth_token=${rawBodySecret}`, {
                status: 503,
                statusText: 'Service Unavailable',
            });
        }
        return syntheticJsonResponse(payloadForAnalyticsOperation(operation));
    }, () => client.getAnalytics({ period: '24h', now }));

    assert.equal(report.success, true);
    assert.equal(report.partial, true);
    assert.equal(report.sections.account.ok, true);
    assert.equal(report.sections.content.ok, false);
    assert.match(report.sections.content.error, /HTTP 503 Service Unavailable/);
    assert.equal(report.sections.video.ok, true);
    assert.deepEqual(report.sectionCounts, { total: 7, succeeded: 6, failed: 1 });
    assert.deepEqual(report.requestCounts, { total: 14, succeeded: 13, failed: 1 });
    assert.doesNotMatch(JSON.stringify(report), new RegExp(rawBodySecret));
});

await test('returns actionable sanitized section failures when every analytics endpoint fails', async () => {
    const client = createSyntheticClient();
    configureOfflineAnalyticsClient(client);
    const rawBodySecret = 'synthetic-all-failed-secret';

    const report = await withStubbedFetch(async (url) => {
        parseAnalyticsUrl(url);
        return new Response(`raw response cookie=${rawBodySecret}`, {
            status: 401,
            statusText: 'Unauthorized',
        });
    }, () => client.getAnalytics({ period: '24h', now }));

    assert.equal(report.success, false);
    assert.equal(report.partial, false);
    assert.match(report.error, /all 7 analytics report sections failed/i);
    assert.match(report.error, /cookies|sign in|authentication/i);
    assert.deepEqual(report.sectionCounts, { total: 7, succeeded: 0, failed: 7 });
    assert.deepEqual(report.requestCounts, { total: 14, succeeded: 0, failed: 14 });
    assert.ok(Object.values(report.sections).every((section) => section.ok === false));
    assert.deepEqual(Object.keys(report.sections.audience.metrics), AUDIENCE_METRICS);
    assert.ok(Object.values(report.sections.audience.metrics).every((metric) => metric.ok === false));
    assert.doesNotMatch(JSON.stringify(report), new RegExp(rawBodySecret));
});

await test('sanitizes HTTP, GraphQL, network, and malformed JSON failures without returning request secrets', async () => {
    const client = createSyntheticClient();
    configureOfflineAnalyticsClient(client);
    const spec = buildAnalyticsRequestSpecs(resolveAnalyticsRange({ period: '24h', now }))[0];
    const secrets = [
        'synthetic-http-secret',
        'synthetic-graphql-secret',
        'synthetic-network-secret',
        'synthetic-malformed-secret',
    ];
    const responses = [
        () => new Response(`RAW_HTTP_BODY auth_token=${secrets[0]}`, { status: 500 }),
        () => syntheticJsonResponse({
            errors: [{ message: `Synthetic denial ct0=${secrets[1]} with safe explanation` }],
        }),
        () => { throw new Error(`Network unavailable cookie=${secrets[2]}`); },
        () => new Response(`RAW_MALFORMED_BODY authorization=Bearer ${secrets[3]}`, { status: 200 }),
    ];
    let responseIndex = 0;

    const results = await withStubbedFetch(async () => responses[responseIndex++](), async () => {
        const failures = [];
        for (let index = 0; index < responses.length; index += 1) {
            failures.push(await client.fetchAnalyticsSpec(spec));
        }
        return failures;
    });

    assert.ok(results.every((result) => result.ok === false));
    assert.match(results[0].error, /HTTP 500/);
    assert.doesNotMatch(results[0].error, /RAW_HTTP_BODY/);
    assert.match(results[1].error, /Synthetic denial.*\[REDACTED\].*safe explanation/);
    assert.match(results[2].error, /Network unavailable.*\[REDACTED\]/);
    assert.match(results[3].error, /valid JSON/i);
    assert.doesNotMatch(results[3].error, /RAW_MALFORMED_BODY/);
    for (const secret of secrets) {
        assert.doesNotMatch(JSON.stringify(results), new RegExp(secret));
    }
    assert.doesNotMatch(JSON.stringify(results), /synthetic-auth-value|synthetic-csrf-value/);
});

await test('rejects analytics responses returned from redirected or non-X URLs without exposing their bodies', async () => {
    const client = createSyntheticClient();
    configureOfflineAnalyticsClient(client);
    const spec = buildAnalyticsRequestSpecs(resolveAnalyticsRange({ period: '24h', now }))[0];
    const bodySecret = 'synthetic-redirect-body-secret';
    const responseUrls = [
        'https://example.invalid/i/api/graphql/redirected/accountOverviewDailyQuery',
        'https://x.com/unexpected/analytics',
    ];
    let responseIndex = 0;

    const results = await withStubbedFetch(async () => {
        const payload = structuredClone(accountPayload);
        payload.data.viewer_v2.user_results.result.redirect_marker = bodySecret;
        const response = syntheticJsonResponse(payload);
        Object.defineProperty(response, 'url', { value: responseUrls[responseIndex++] });
        return response;
    }, async () => {
        const failures = [];
        for (const _responseUrl of responseUrls) {
            failures.push(await client.fetchAnalyticsSpec(spec));
        }
        return failures;
    });

    assert.ok(results.every((result) => result.ok === false));
    assert.ok(results.every((result) => /unexpected.*URL|redirect/i.test(result.error)));
    assert.doesNotMatch(JSON.stringify(results), new RegExp(bodySecret));
    assert.equal(responseIndex, 2);
});

const MAX_ANALYTICS_RESPONSE_BYTES = 4 * 1024 * 1024;

await test('rejects an oversized declared analytics Content-Length before parsing the body', async () => {
    const client = createSyntheticClient();
    configureOfflineAnalyticsClient(client);
    const spec = buildAnalyticsRequestSpecs(resolveAnalyticsRange({ period: '24h', now }))[0];
    const bodySecret = 'synthetic-declared-size-body-secret';
    const payload = structuredClone(accountPayload);
    payload.data.viewer_v2.user_results.result.oversized_marker = bodySecret;

    const result = await withStubbedFetch(async () => new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-length': String(MAX_ANALYTICS_RESPONSE_BYTES + 1) },
    }), () => client.fetchAnalyticsSpec(spec));

    assert.equal(result.ok, false);
    assert.match(result.error, /4 MiB|maximum.*size|too large/i);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(bodySecret));
});

await test('cancels and awaits an unread analytics body rejected by declared Content-Length', async () => {
    const client = createSyntheticClient();
    configureOfflineAnalyticsClient(client);
    const spec = buildAnalyticsRequestSpecs(resolveAnalyticsRange({ period: '24h', now }))[0];
    let cancelCalls = 0;
    let cancellationSettled = false;
    const body = new ReadableStream({
        async cancel() {
            cancelCalls += 1;
            await Promise.resolve();
            cancellationSettled = true;
        },
    });

    const result = await withStubbedFetch(async () => new Response(body, {
        status: 200,
        headers: { 'content-length': String(MAX_ANALYTICS_RESPONSE_BYTES + 1) },
    }), () => client.fetchAnalyticsSpec(spec));

    assert.equal(result.ok, false);
    assert.match(result.error, /4 MiB|maximum.*size|too large/i);
    assert.equal(cancelCalls, 1);
    assert.equal(cancellationSettled, true);
});

await test('stops and rejects a chunked analytics body once its decompressed size exceeds 4 MiB', async () => {
    const client = createSyntheticClient();
    configureOfflineAnalyticsClient(client);
    const spec = buildAnalyticsRequestSpecs(resolveAnalyticsRange({ period: '24h', now }))[0];
    const bodySecret = 'synthetic-stream-size-body-secret';
    const secretChunk = new TextEncoder().encode(bodySecret);
    const body = new ReadableStream({
        start(controller) {
            controller.enqueue(new Uint8Array(2 * 1024 * 1024));
            controller.enqueue(new Uint8Array(2 * 1024 * 1024));
            controller.enqueue(secretChunk);
            controller.close();
        },
    });

    const result = await withStubbedFetch(async () => new Response(body, { status: 200 }),
        () => client.fetchAnalyticsSpec(spec));

    assert.equal(result.ok, false);
    assert.match(result.error, /4 MiB|maximum.*size|too large/i);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(bodySecret));
});

await test('cancels and awaits an active analytics reader after invalid UTF-8', async () => {
    const client = createSyntheticClient();
    configureOfflineAnalyticsClient(client);
    const spec = buildAnalyticsRequestSpecs(resolveAnalyticsRange({ period: '24h', now }))[0];
    let cancelCalls = 0;
    let cancellationSettled = false;
    const body = new ReadableStream({
        start(controller) {
            controller.enqueue(Uint8Array.from([0xc3, 0x28]));
        },
        async cancel() {
            cancelCalls += 1;
            await Promise.resolve();
            cancellationSettled = true;
        },
    });

    const result = await withStubbedFetch(async () => new Response(body, { status: 200 }),
        () => client.fetchAnalyticsSpec(spec));

    assert.equal(result.ok, false);
    assert.match(result.error, /UTF-8 JSON/i);
    assert.equal(cancelCalls, 1);
    assert.equal(cancellationSettled, true);
});

await test('parses a within-limit streamed analytics response without using unbounded Response.json', async () => {
    const client = createSyntheticClient();
    configureOfflineAnalyticsClient(client);
    const spec = buildAnalyticsRequestSpecs(resolveAnalyticsRange({ period: '24h', now }))[0];
    const bodyText = JSON.stringify(accountPayload);

    const result = await withStubbedFetch(async () => {
        const response = new Response(bodyText, {
            status: 200,
            headers: { 'content-length': String(new TextEncoder().encode(bodyText).byteLength) },
        });
        Object.defineProperty(response, 'json', {
            value: async () => { throw new Error('unbounded Response.json must not be used'); },
        });
        return response;
    }, () => client.fetchAnalyticsSpec(spec));

    assert.equal(result.ok, true);
    assert.equal(result.data.followers, 120);
});

await test('safely parses a small declared analytics body when a test response has no stream', async () => {
    const client = createSyntheticClient();
    configureOfflineAnalyticsClient(client);
    const spec = buildAnalyticsRequestSpecs(resolveAnalyticsRange({ period: '24h', now }))[0];
    const bodyText = JSON.stringify(accountPayload);
    const contentLength = new TextEncoder().encode(bodyText).byteLength;

    const result = await withStubbedFetch(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        url: '',
        headers: new Headers({ 'content-length': String(contentLength) }),
        body: null,
        text: async () => bodyText,
    }), () => client.fetchAnalyticsSpec(spec));

    assert.equal(result.ok, true);
    assert.equal(result.data.followers, 120);
});

await test('refreshes an analytics query ID after a 404 mismatch and retries exactly once', async () => {
    const client = createSyntheticClient();
    const spec = buildAnalyticsRequestSpecs(resolveAnalyticsRange({ period: '24h', now }))[0];
    let queryIdCalls = 0;
    let refreshCalls = 0;
    let fetchCalls = 0;
    client.getQueryId = async (operation) => {
        queryIdCalls += 1;
        return ANALYTICS_QUERY_IDS[operation];
    };
    client.refreshQueryIds = async () => {
        refreshCalls += 1;
    };

    const result = await withStubbedFetch(async (url) => {
        parseAnalyticsUrl(url);
        fetchCalls += 1;
        return fetchCalls === 1
            ? new Response('synthetic query mismatch', { status: 404 })
            : syntheticJsonResponse(accountPayload);
    }, () => client.fetchAnalyticsSpec(spec));

    assert.equal(result.ok, true);
    assert.equal(queryIdCalls, 2);
    assert.equal(refreshCalls, 1);
    assert.equal(fetchCalls, 2);
});

await test('uses the exact allowlisted fallback when query ID resolution has no valid value', async () => {
    const client = createSyntheticClient();
    const spec = buildAnalyticsRequestSpecs(resolveAnalyticsRange({ period: '24h', now }))[0];
    client.getQueryId = async () => undefined;

    const result = await withStubbedFetch(async (url) => {
        const parsed = parseAnalyticsUrl(url);
        return syntheticJsonResponse(payloadForAnalyticsOperation(parsed.operation));
    }, () => client.fetchAnalyticsSpec(spec));

    assert.equal(result.ok, true);
    assert.equal(result.operation, 'accountOverviewDailyQuery');
});

await test('restores the original global fetch even when an analytics test callback throws', async () => {
    const originalFetch = globalThis.fetch;
    await assert.rejects(
        withStubbedFetch(async () => syntheticJsonResponse(accountPayload), async () => {
            throw new Error('synthetic callback failure');
        }),
        /synthetic callback failure/,
    );
    assert.equal(globalThis.fetch, originalFetch);
});

console.log('analytics human summary');

await test('summarizes range, account, content, audience, media, video, live, and Spaces', () => {
    const contentWithRunnerUp = structuredClone(contentPayload);
    contentWithRunnerUp.data.viewer_v2.user_results.result.tweets_results.push({ result: {
        rest_id: 'synthetic-post-101',
        details: { full_text: 'Synthetic smaller note', created_at_ms: 1787094000000 },
        organic_metrics_total: [
            { metric_type: 'Impressions', metric_value: 200 },
            { metric_type: 'Engagements', metric_value: 8 },
        ],
    } });
    const specsAndPayloads = [
        [{ section: 'account', operation: 'accountOverviewDailyQuery', variables: {} }, accountPayload],
        [{ section: 'content', operation: 'contentPageQuery', variables: {} }, contentWithRunnerUp],
        [{
            section: 'audience:Likes',
            operation: 'audienceOverviewDataQuery',
            variables: { engagement_type: 'Likes' },
        }, audiencePayload],
        [{ section: 'media', operation: 'mediaMetricsQuery', variables: {} }, mediaPayload],
        [{ section: 'video', operation: 'videoListProviderQuery', variables: {} }, videoPayload],
        [{ section: 'live', operation: 'liveOverviewProviderQuery', variables: {} }, livePayload],
        [{ section: 'spaces', operation: 'spacesOverviewProviderQuery', variables: {} }, spacesPayload],
    ];
    const report = {
        success: true,
        partial: false,
        range: resolveAnalyticsRange({ period: '24h', now }),
        sections: specsAndPayloads.map(([spec, payload]) => normalizeAnalyticsSection(spec, payload)),
        request: {
            authorization: 'Bearer synthetic-secret-value',
            cookie: 'auth_token=synthetic-secret-value',
        },
    };
    const summary = summarizeAnalyticsReport(report);

    assert.match(summary, /X Analytics — 24h/);
    assert.match(summary, /2026-08-18T16:00:00.000Z.*2026-08-19T16:00:00.000Z/);
    assert.match(summary, /Followers: 120 \(7 verified\)/);
    assert.match(summary, /Account metrics:.*Impressions 900.*Likes 45/);
    assert.match(summary, /Top content:/);
    assert.ok(summary.indexOf('Synthetic launch note') < summary.indexOf('Synthetic smaller note'));
    assert.match(summary, /Synthetic launch note.*500 impressions.*25 engagements/i);
    assert.match(summary, /Audience highlights:.*Likes 30/);
    assert.match(summary, /Media:.*64 video views.*900 watch time.*12 completed/i);
    assert.match(summary, /Video inventory:.*1 item.*44 video views.*600 watch time/i);
    assert.match(summary, /Live: No data/);
    assert.match(summary, /Spaces: No data/);
    assert.doesNotMatch(summary, /synthetic-secret-value|auth_token|authorization|cookie|"request"/i);
    assert.doesNotMatch(summary, /^\s*[{[]/);
});

await test('summarizes object-shaped partial sections without exposing their errors', () => {
    const report = {
        success: true,
        partial: true,
        sections: {
            account: { ok: false, section: 'account', error: 'auth_token=synthetic-secret-value' },
            content: {
                ok: true,
                section: 'content',
                operation: 'contentPageQuery',
                data: { posts: [] },
            },
        },
    };
    const summary = summarizeAnalyticsReport(report);

    assert.match(summary, /Partial report/);
    assert.match(summary, /Range: No data/);
    assert.match(summary, /Followers: No data/);
    assert.match(summary, /Account metrics: No data/);
    assert.match(summary, /Top content: No data/);
    assert.match(summary, /Audience highlights: No data/);
    assert.match(summary, /Media: No data/);
    assert.match(summary, /Video inventory: No data/);
    assert.match(summary, /Live: No data/);
    assert.match(summary, /Spaces: No data/);
    assert.doesNotMatch(summary, /synthetic-secret-value|auth_token/i);
});

await test('redacts a complete bearer credential when an error message is rendered in a summary', () => {
    const secret = 'synthetic-summary-secret';
    const renderedError = new Error(`Denied Authorization: Bearer ${secret}; keep this explanation`);
    const summary = summarizeAnalyticsReport({
        sections: [{
            ok: true,
            section: 'content',
            operation: 'contentPageQuery',
            data: {
                posts: [{
                    id: 'synthetic-error-row',
                    text: renderedError.message,
                    createdAt: null,
                    media: [],
                    metricTotals: {},
                }],
            },
        }],
    });

    assert.match(summary, /Denied Authorization: \[REDACTED\]; keep this explanation/);
    assert.doesNotMatch(summary, new RegExp(secret));
});

await test('redacts quoted bearer errors rendered in human summaries', () => {
    const doubleSecret = 'synthetic-summary-double-secret';
    const singleSecret = 'synthetic-summary-single-secret';
    const summary = summarizeAnalyticsReport({
        sections: [{
            ok: true,
            section: 'content',
            operation: 'contentPageQuery',
            data: {
                posts: [
                    {
                        id: 'synthetic-double-error',
                        text: new Error(`Denied Authorization: Bearer "${doubleSecret}"; double detail retained`).message,
                        createdAt: null,
                        media: [],
                        metricTotals: { Impressions: 2 },
                    },
                    {
                        id: 'synthetic-single-error',
                        text: new Error(`Denied aUtHoRiZaTiOn=bEaReR '${singleSecret}', single detail retained`).message,
                        createdAt: null,
                        media: [],
                        metricTotals: { Impressions: 1 },
                    },
                ],
            },
        }],
    });

    assert.match(summary, /Denied Authorization: \[REDACTED\]; double detail retained/);
    assert.match(summary, /Denied aUtHoRiZaTiOn=\[REDACTED\], single detail retained/);
    assert.doesNotMatch(summary, new RegExp(`${doubleSecret}|${singleSecret}`));
});

await test('summarizes missing optional report data without throwing', () => {
    const summary = summarizeAnalyticsReport({});

    assert.equal(summary.split('\n').filter(Boolean).length >= 9, true);
    assert.match(summary, /Range: No data/);
    assert.match(summary, /Followers: No data/);
    assert.match(summary, /Top content: No data/);
    assert.match(summary, /Audience highlights: No data/);
    assert.match(summary, /Media: No data/);
    assert.match(summary, /Video inventory: No data/);
});

await test('labels successfully normalized empty sections as No data', () => {
    const emptyPayload = { data: { viewer_v2: { user_results: { result: {} } } } };
    const sections = Object.entries(ANALYTICS_QUERY_IDS).map(([operation]) => normalizeAnalyticsSection(
        {
            section: operation === 'accountOverviewDailyQuery'
                ? 'account'
                : operation.replace(/(?:Overview|Data|Page|Metrics|List|Provider|Daily|Query)/g, '').toLowerCase(),
            operation,
            variables: {},
        },
        emptyPayload,
    ));
    const summary = summarizeAnalyticsReport({ sections });

    assert.match(summary, /Followers: No data/);
    assert.match(summary, /Account metrics: No data/);
    assert.match(summary, /Top content: No data/);
    assert.match(summary, /Audience highlights: No data/);
    assert.match(summary, /Media: No data/);
    assert.match(summary, /Video inventory: No data/);
    assert.match(summary, /Live: No data/);
    assert.match(summary, /Spaces: No data/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
