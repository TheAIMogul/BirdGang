const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MAX_DATE_MS = 8_640_000_000_000_000;
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
    if (Math.abs(now) > MAX_DATE_MS) {
        throw new Error('Analytics range end is outside the supported Date range');
    }

    const duration = amount * (match[2].toLowerCase() === 'h' ? HOUR_MS : DAY_MS);
    const fromMs = now - duration;
    if (!Number.isFinite(fromMs) || Math.abs(fromMs) > MAX_DATE_MS) {
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
    const previousFrom = range.fromMs - duration;
    if (!Number.isFinite(previousFrom) || Math.abs(previousFrom) > MAX_DATE_MS) {
        throw new Error('Analytics previous range is outside the supported Date range');
    }
    const accountVariables = {
        current_from: range.fromMs,
        current_from_iso: range.fromIso,
        current_to: range.toExclusiveMs,
        current_to_iso: range.toExclusiveIso,
        prev_from: previousFrom,
        prev_from_iso: new Date(previousFrom).toISOString(),
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

function sanitizeAnalyticsErrorMessage(message) {
    return String(message || 'GraphQL error')
        .replace(/(["']?)(auth_token|ct0|x-csrf-token|authorization|cookie)\1\s*([:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi, '$1$2$1$3[REDACTED]')
        .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]');
}

export function unwrapAnalyticsResult(payload) {
    const errors = Array.isArray(payload?.errors) ? payload.errors : [];
    if (errors.length > 0) {
        throw new Error(errors
            .map((error) => sanitizeAnalyticsErrorMessage(error?.message))
            .join(', '));
    }

    const result = payload?.data?.viewer_v2?.user_results?.result;
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
        throw new Error('X Analytics response did not include an authenticated user result');
    }
    return result;
}

export function metricArrayToObject(values) {
    const output = {};
    for (const item of Array.isArray(values) ? values : []) {
        if (typeof item?.metric_type !== 'string' || item.metric_type.trim() === '') {
            continue;
        }
        if (typeof item.metric_value !== 'number'
            && (typeof item.metric_value !== 'string' || item.metric_value.trim() === '')) {
            continue;
        }
        const value = Number(item.metric_value);
        if (Number.isFinite(value)) {
            output[item.metric_type] = value;
        }
    }
    return output;
}

function addMetric(total, name, value) {
    if (typeof name !== 'string' || name.trim() === '') {
        return;
    }
    const numericValue = Number(value);
    if (Number.isFinite(numericValue)) {
        total[name] = (total[name] || 0) + numericValue;
    }
}

function toFiniteNumber(value) {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') {
        return null;
    }
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue : null;
}

function aggregateMetricRows(rows) {
    const total = {};
    for (const row of Array.isArray(rows) ? rows : []) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
            continue;
        }
        addMetric(total, row.metric_type ?? row.engagement_type, row.metric_value ?? row.count);
        for (const [name, value] of Object.entries(metricArrayToObject(
            row.metric_values ?? row.metrics ?? row.values,
        ))) {
            addMetric(total, name, value);
        }
    }
    return total;
}

function normalizeAccountResult(result) {
    return {
        ...result,
        followers: toFiniteNumber(result.relationship_counts?.followers),
        verifiedFollowers: toFiniteNumber(result.verified_follower_count),
        timeSeries: Array.isArray(result.current_time_series) ? result.current_time_series : [],
        followMetrics: result.follow_metrics && typeof result.follow_metrics === 'object'
            ? result.follow_metrics
            : {},
        metrics: aggregateMetricRows(result.current_time_series),
    };
}

function normalizeContentResult(result) {
    const posts = [];
    for (const entry of Array.isArray(result.tweets_results) ? result.tweets_results : []) {
        const source = entry?.result;
        if (!source || typeof source !== 'object' || Array.isArray(source)) {
            continue;
        }
        const details = source.details && typeof source.details === 'object' ? source.details : {};
        posts.push({
            ...source,
            id: source.rest_id ?? source.id ?? '',
            text: details.full_text ?? source.full_text ?? source.text ?? '',
            createdAt: details.created_at_ms ?? source.created_at_ms ?? source.createdAt ?? null,
            media: Array.isArray(details.media)
                ? details.media
                : (Array.isArray(source.media) ? source.media : []),
            metrics: metricArrayToObject(source.organic_metrics_total ?? source.metrics),
        });
    }
    return { ...result, posts };
}

function normalizeAudienceResult(spec, result) {
    const requestedMetric = typeof spec?.variables?.engagement_type === 'string'
        ? spec.variables.engagement_type
        : (typeof spec?.section === 'string' && spec.section.startsWith('audience:')
            ? spec.section.slice('audience:'.length)
            : undefined);
    return {
        ...result,
        requestedMetric,
        organicTimeSeries: Array.isArray(result.organic_time_series) ? result.organic_time_series : [],
        demographics: Array.isArray(result.demographic_rows) ? result.demographic_rows : [],
        countries: Array.isArray(result.country_rows) ? result.country_rows : [],
    };
}

function normalizeMediaResult(result) {
    const metricTimeSeries = Array.isArray(result.metric_time_series) ? result.metric_time_series : [];
    return {
        ...result,
        metricTimeSeries,
        metrics: aggregateMetricRows(metricTimeSeries),
    };
}

function normalizeVideoResult(result) {
    const mediaInventory = Array.isArray(result.media_results) ? result.media_results : [];
    const metrics = {};
    for (const item of mediaInventory) {
        for (const [name, value] of Object.entries(metricArrayToObject(
            item?.metrics ?? item?.organic_metrics_total,
        ))) {
            addMetric(metrics, name, value);
        }
    }
    return { ...result, mediaInventory, metrics };
}

export function normalizeAnalyticsSection(spec, payload) {
    const result = unwrapAnalyticsResult(payload);
    let data;
    switch (spec.operation) {
        case 'accountOverviewDailyQuery':
            data = normalizeAccountResult(result);
            break;
        case 'audienceOverviewDataQuery':
            data = normalizeAudienceResult(spec, result);
            break;
        case 'contentPageQuery':
            data = normalizeContentResult(result);
            break;
        case 'mediaMetricsQuery':
            data = normalizeMediaResult(result);
            break;
        case 'videoListProviderQuery':
            data = normalizeVideoResult(result);
            break;
        default:
            data = { ...result };
    }

    const section = {
        ok: true,
        section: spec.section,
        operation: spec.operation,
        data,
    };
    if (spec.operation === 'audienceOverviewDataQuery') {
        section.metric = data.requestedMetric;
    }
    return section;
}

function reportSections(report) {
    if (Array.isArray(report?.sections)) {
        return report.sections;
    }
    if (report?.sections && typeof report.sections === 'object') {
        return Object.values(report.sections);
    }
    return [];
}

function findSuccessfulSection(sections, sectionName, operation) {
    return sections.find((section) => section?.ok === true
        && (section.section === sectionName || section.operation === operation));
}

function finiteMetric(metrics, ...names) {
    for (const name of names) {
        const value = toFiniteNumber(metrics?.[name]);
        if (value !== null) {
            return value;
        }
    }
    return null;
}

function formatCount(value) {
    return Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function safeSummaryText(value, maxLength = 96) {
    const text = sanitizeAnalyticsErrorMessage(String(value ?? ''))
        .replace(/\s+/g, ' ')
        .trim();
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function formatMetricSummary(metrics) {
    return Object.entries(metrics && typeof metrics === 'object' ? metrics : {})
        .filter(([name, value]) => typeof name === 'string'
            && !/(?:auth|cookie|csrf|token|request|variable)/i.test(name)
            && Number.isFinite(Number(value)))
        .map(([name, value]) => `${safeSummaryText(name, 40)} ${formatCount(value)}`)
        .join(', ');
}

function audienceHighlight(section) {
    const data = section?.data;
    const metric = section?.metric ?? data?.requestedMetric;
    if (typeof metric !== 'string' || metric.length === 0) {
        return null;
    }
    const totals = aggregateMetricRows(data?.organicTimeSeries);
    let metricTotal = finiteMetric(totals, metric);
    if (metricTotal === null) {
        const values = (Array.isArray(data?.organicTimeSeries) ? data.organicTimeSeries : [])
            .map((row) => toFiniteNumber(row?.metric_value ?? row?.count))
            .filter((value) => value !== null);
        if (values.length > 0) {
            metricTotal = values.reduce((sum, value) => sum + value, 0);
        }
    }
    if (metricTotal === null) {
        return null;
    }
    return `${safeSummaryText(metric, 40)} ${formatCount(metricTotal)}`;
}

function highestCountRow(rows) {
    return (Array.isArray(rows) ? rows : [])
        .filter((row) => Number.isFinite(Number(row?.count)))
        .slice()
        .sort((left, right) => Number(right.count) - Number(left.count))[0];
}

function collectionCount(data, names) {
    for (const name of names) {
        if (Array.isArray(data?.[name])) {
            return data[name].length;
        }
    }
    return 0;
}

export function summarizeAnalyticsReport(report) {
    const sections = reportSections(report);
    const range = report?.range;
    const period = typeof range?.period === 'string' ? safeSummaryText(range.period, 80) : '';
    const lines = [period ? `X Analytics — ${period}` : 'X Analytics'];
    if (report?.partial === true) {
        lines.push('Partial report');
    }

    if (typeof range?.fromIso === 'string' && typeof range?.toExclusiveIso === 'string') {
        lines.push(`Range: ${safeSummaryText(range.fromIso)} to ${safeSummaryText(range.toExclusiveIso)}`);
    }
    else {
        lines.push('Range: No data');
    }

    const account = findSuccessfulSection(sections, 'account', 'accountOverviewDailyQuery');
    const followers = toFiniteNumber(account?.data?.followers);
    if (followers !== null) {
        const verifiedFollowers = toFiniteNumber(account?.data?.verifiedFollowers);
        lines.push(verifiedFollowers !== null
            ? `Followers: ${formatCount(followers)} (${formatCount(verifiedFollowers)} verified)`
            : `Followers: ${formatCount(followers)}`);
    }
    else {
        lines.push('Followers: No data');
    }
    const accountMetrics = formatMetricSummary(account?.data?.metrics);
    lines.push(`Account metrics: ${accountMetrics || 'No data'}`);

    const content = findSuccessfulSection(sections, 'content', 'contentPageQuery');
    const posts = Array.isArray(content?.data?.posts) ? content.data.posts : [];
    if (posts.length === 0) {
        lines.push('Top content: No data');
    }
    else {
        const topPosts = posts.slice().sort((left, right) => {
            const rightScore = finiteMetric(right?.metrics, 'Impressions', 'Engagements') ?? 0;
            const leftScore = finiteMetric(left?.metrics, 'Impressions', 'Engagements') ?? 0;
            return rightScore - leftScore;
        }).slice(0, 3);
        lines.push('Top content:');
        for (const post of topPosts) {
            const text = safeSummaryText(post?.text || post?.id || 'Untitled post');
            const impressions = finiteMetric(post?.metrics, 'Impressions');
            const engagements = finiteMetric(post?.metrics, 'Engagements');
            const metrics = [];
            if (impressions !== null) metrics.push(`${formatCount(impressions)} impressions`);
            if (engagements !== null) metrics.push(`${formatCount(engagements)} engagements`);
            lines.push(`  - ${text}${metrics.length > 0 ? ` — ${metrics.join(', ')}` : ' — No data'}`);
        }
    }

    const audienceSections = sections.filter((section) => section?.ok === true
        && (section.operation === 'audienceOverviewDataQuery'
            || (typeof section.section === 'string' && section.section.startsWith('audience:'))));
    const audienceParts = audienceSections.map(audienceHighlight).filter(Boolean);
    const demographic = highestCountRow(audienceSections.flatMap((section) => section?.data?.demographics ?? []));
    const country = highestCountRow(audienceSections.flatMap((section) => section?.data?.countries ?? []));
    if (demographic) {
        audienceParts.push(`${safeSummaryText(demographic.value ?? demographic.dimension, 40)} ${formatCount(demographic.count)}`);
    }
    if (country) {
        audienceParts.push(`${safeSummaryText(country.country_name ?? country.country_code, 40)} ${formatCount(country.count)}`);
    }
    lines.push(`Audience highlights: ${audienceParts.length > 0 ? audienceParts.join(', ') : 'No data'}`);

    const media = findSuccessfulSection(sections, 'media', 'mediaMetricsQuery');
    const mediaViews = finiteMetric(media?.data?.metrics, 'VideoView', 'VideoViews');
    const mediaWatchTime = finiteMetric(media?.data?.metrics, 'WatchTime');
    const mediaCompleted = finiteMetric(media?.data?.metrics, 'PlaybackComplete');
    const mediaParts = [];
    if (mediaViews !== null) mediaParts.push(`${formatCount(mediaViews)} video views`);
    if (mediaWatchTime !== null) mediaParts.push(`${formatCount(mediaWatchTime)} watch time`);
    if (mediaCompleted !== null) mediaParts.push(`${formatCount(mediaCompleted)} completed`);
    lines.push(`Media: ${mediaParts.length > 0 ? mediaParts.join(', ') : 'No data'}`);

    const video = findSuccessfulSection(sections, 'video', 'videoListProviderQuery');
    const inventory = Array.isArray(video?.data?.mediaInventory) ? video.data.mediaInventory : [];
    const videoViews = finiteMetric(video?.data?.metrics, 'VideoView', 'VideoViews');
    const videoWatchTime = finiteMetric(video?.data?.metrics, 'WatchTime');
    const videoParts = [];
    if (inventory.length > 0) videoParts.push(`${formatCount(inventory.length)} ${inventory.length === 1 ? 'item' : 'items'}`);
    if (videoViews !== null) videoParts.push(`${formatCount(videoViews)} video views`);
    if (videoWatchTime !== null) videoParts.push(`${formatCount(videoWatchTime)} watch time`);
    lines.push(`Video inventory: ${videoParts.length > 0 ? videoParts.join(', ') : 'No data'}`);

    const live = findSuccessfulSection(sections, 'live', 'liveOverviewProviderQuery');
    const liveCount = collectionCount(live?.data, ['live_results', 'liveResults', 'items']);
    lines.push(`Live: ${liveCount > 0 ? `${formatCount(liveCount)} ${liveCount === 1 ? 'item' : 'items'}` : 'No data'}`);

    const spaces = findSuccessfulSection(sections, 'spaces', 'spacesOverviewProviderQuery');
    const spacesCount = collectionCount(spaces?.data, ['spaces_results', 'spacesResults', 'items']);
    lines.push(`Spaces: ${spacesCount > 0 ? `${formatCount(spacesCount)} ${spacesCount === 1 ? 'item' : 'items'}` : 'No data'}`);

    return lines.join('\n');
}
