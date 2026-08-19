const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const PERIOD_RE = /^(\d+)(h|d)$/i;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

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

function hasValidCalendarDate(input) {
    const year = Number(input.slice(0, 4));
    const month = Number(input.slice(5, 7));
    const day = Number(input.slice(8, 10));
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth[month - 1];
}

function parseExplicitBoundary(value, isInclusiveDateOnlyEnd) {
    const input = typeof value === 'string' ? value.trim() : '';
    const isDateOnly = DATE_ONLY_RE.test(input);
    if (!isDateOnly && !ISO_DATE_TIME_RE.test(input)) {
        throw new Error(`Invalid analytics date boundary: ${String(value)}`);
    }
    if (!hasValidCalendarDate(input)) {
        throw new Error(`Invalid analytics date boundary: ${String(value)}`);
    }
    const iso = isDateOnly ? `${input}T00:00:00.000Z` : input;
    let timestamp = Date.parse(iso);

    if (!Number.isFinite(timestamp) || (isDateOnly && new Date(timestamp).toISOString().slice(0, 10) !== input)) {
        throw new Error(`Invalid analytics date boundary: ${String(value)}`);
    }
    if (isDateOnly && isInclusiveDateOnlyEnd) {
        timestamp += DAY_MS;
    }

    return {
        timestamp,
        iso: isDateOnly ? new Date(timestamp).toISOString() : input,
    };
}

export function resolveAnalyticsRange(options = {}) {
    const { period, from, to, now = Date.now() } = options;
    const hasPeriod = period !== undefined;
    const hasExplicitBoundary = from !== undefined || to !== undefined;

    if (hasPeriod && hasExplicitBoundary) {
        throw new Error('--period and --from/--to are mutually exclusive');
    }
    if (hasExplicitBoundary && (from === undefined || to === undefined)) {
        throw new Error('Analytics ranges require both --from and --to');
    }

    if (hasExplicitBoundary) {
        const fromBoundary = parseExplicitBoundary(from, false);
        const toBoundary = parseExplicitBoundary(to, true);
        if (fromBoundary.timestamp >= toBoundary.timestamp) {
            throw new Error('Analytics --from must be before --to');
        }
        return {
            fromMs: fromBoundary.timestamp,
            toExclusiveMs: toBoundary.timestamp,
            fromIso: fromBoundary.iso,
            toExclusiveIso: toBoundary.iso,
            period: `${String(from).trim()} to ${String(to).trim()}`,
        };
    }

    const normalizedPeriod = hasPeriod ? String(period).trim().toLowerCase() : '28d';
    const match = PERIOD_RE.exec(normalizedPeriod);
    if (!match) {
        throw new Error('Invalid analytics period. Expected a positive integer followed by h or d');
    }

    const amount = Number(match[1]);
    if (amount <= 0) {
        throw new Error('Analytics period must be positive');
    }
    if (!Number.isFinite(now)) {
        throw new Error('Analytics range end must be a finite timestamp');
    }

    const duration = amount * (match[2].toLowerCase() === 'h' ? HOUR_MS : DAY_MS);
    const fromMs = now - duration;
    if (!Number.isFinite(fromMs)) {
        throw new Error('Analytics period is too large');
    }

    return {
        fromMs,
        toExclusiveMs: now,
        fromIso: new Date(fromMs).toISOString(),
        toExclusiveIso: new Date(now).toISOString(),
        period: normalizedPeriod,
    };
}

export function buildAnalyticsRequestSpecs(range) {
    const duration = range.toExclusiveMs - range.fromMs;
    const inclusiveTo = range.toExclusiveMs - 1;
    const accountVariables = {
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
    };
    const inclusiveRange = {
        from: range.fromMs,
        to: inclusiveTo,
    };

    return [
        {
            section: 'account',
            operation: 'accountOverviewDailyQuery',
            variables: accountVariables,
        },
        ...AUDIENCE_METRICS.map((metric) => ({
            section: `audience:${metric}`,
            operation: 'audienceOverviewDataQuery',
            variables: {
                ...inclusiveRange,
                engagement_type: metric,
            },
        })),
        {
            section: 'content',
            operation: 'contentPageQuery',
            variables: {
                from: range.fromIso,
                to: range.toExclusiveIso,
                metrics: [...CONTENT_METRICS],
                max_results: 1000,
                query_page_size: 100,
            },
        },
        {
            section: 'media',
            operation: 'mediaMetricsQuery',
            variables: {
                ...inclusiveRange,
                metrics: [...MEDIA_METRICS],
            },
        },
        {
            section: 'video',
            operation: 'videoListProviderQuery',
            variables: {
                ...inclusiveRange,
                limit: 30,
                cursor: null,
                estimatedRevenueEnabled: true,
            },
        },
        {
            section: 'live',
            operation: 'liveOverviewProviderQuery',
            variables: {
                ...inclusiveRange,
                limit: 30,
                cursor: { offset: '0' },
            },
        },
        {
            section: 'spaces',
            operation: 'spacesOverviewProviderQuery',
            variables: {
                ...inclusiveRange,
                limit: 30,
                cursor: null,
            },
        },
    ];
}
