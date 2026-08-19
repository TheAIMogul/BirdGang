export declare const ANALYTICS_QUERY_IDS: Readonly<{
    accountOverviewDailyQuery: '_P1caq0YB4SVuEtFLPDMfQ';
    audienceOverviewDataQuery: 'H47r_cVD9Uu-qMQLktBCKA';
    contentPageQuery: 'eyqFN-MJHrF7Aq4O5aFBpQ';
    mediaMetricsQuery: 'rLhXZ6PgS37AqskrfVxB1Q';
    videoListProviderQuery: 'J3onn09mCCgjoOo_qNfKuw';
    liveOverviewProviderQuery: 'Yyjk9PyFdDwcmVjRpWP88w';
    spacesOverviewProviderQuery: 'wIGXkaCs_sGftZXvwDLqTg';
}>;

export declare const CONTENT_METRICS: readonly [
    'Impressions', 'Likes', 'Engagements', 'Bookmark', 'Share', 'Follows',
    'Replies', 'Retweets', 'ProfileVisits', 'DetailExpands', 'UrlClicks',
    'HashtagClicks', 'PermalinkClicks',
];

export declare const AUDIENCE_METRICS: readonly [
    'Likes', 'Bookmark', 'Impressions', 'Follows', 'Share', 'Replies',
    'Retweets', 'ProfileVisits',
];

export declare const MEDIA_METRICS: readonly [
    'Playback25', 'Playback50', 'Playback75', 'PlaybackComplete',
    'PlaybackStart', 'VideoView', 'WatchTime',
];

export type AnalyticsOperation = keyof typeof ANALYTICS_QUERY_IDS;
export type ContentMetric = (typeof CONTENT_METRICS)[number];
export type AudienceMetric = (typeof AUDIENCE_METRICS)[number];
export type MediaMetric = (typeof MEDIA_METRICS)[number];

export interface AnalyticsRangeOptions {
    period?: string;
    from?: string;
    to?: string;
    now?: number;
}

export interface AnalyticsRange {
    fromMs: number;
    toExclusiveMs: number;
    fromIso: string;
    toExclusiveIso: string;
    period: string;
}

export interface AnalyticsRequestSpec {
    section: string;
    operation: AnalyticsOperation;
    variables: Record<string, unknown>;
}

export interface AnalyticsSourceObject {
    [key: string]: unknown;
}

export interface AnalyticsMetricRow extends AnalyticsSourceObject {
    metric_type?: string;
    metric_value?: number | string;
    engagement_type?: string;
    count?: number | string;
    timestamp?: number | string;
}

export type AnalyticsMetricValues = Record<string, number>;

export interface AnalyticsAccountData extends AnalyticsSourceObject {
    followers: number | null;
    verifiedFollowers: number | null;
    timeSeries: AnalyticsMetricRow[];
    followMetrics: AnalyticsSourceObject;
    metrics: AnalyticsMetricValues;
}

export interface AnalyticsPost extends AnalyticsSourceObject {
    id: string;
    text: string;
    createdAt: unknown;
    media: unknown[];
    metrics: AnalyticsMetricValues;
}

export interface AnalyticsContentData extends AnalyticsSourceObject {
    posts: AnalyticsPost[];
}

export interface AnalyticsAudienceData extends AnalyticsSourceObject {
    requestedMetric?: string;
    organicTimeSeries: AnalyticsMetricRow[];
    demographics: AnalyticsSourceObject[];
    countries: AnalyticsSourceObject[];
}

export interface AnalyticsMediaData extends AnalyticsSourceObject {
    metricTimeSeries: AnalyticsMetricRow[];
    metrics: AnalyticsMetricValues;
}

export interface AnalyticsVideoData extends AnalyticsSourceObject {
    mediaInventory: AnalyticsSourceObject[];
    metrics: AnalyticsMetricValues;
}

export type AnalyticsNormalizedData =
    | AnalyticsAccountData
    | AnalyticsContentData
    | AnalyticsAudienceData
    | AnalyticsMediaData
    | AnalyticsVideoData
    | AnalyticsSourceObject;

export interface AnalyticsSectionSuccess<T extends AnalyticsSourceObject = AnalyticsNormalizedData> {
    ok: true;
    section: string;
    operation: AnalyticsOperation;
    data: T;
    metric?: AudienceMetric | string;
}

export interface AnalyticsSectionFailure {
    ok: false;
    section: string;
    operation?: AnalyticsOperation;
    metric?: AudienceMetric | string;
    error: string;
}

export type AnalyticsSectionResult<T extends AnalyticsSourceObject = AnalyticsNormalizedData> =
    | AnalyticsSectionSuccess<T>
    | AnalyticsSectionFailure;

export interface AnalyticsReport extends AnalyticsSourceObject {
    range: AnalyticsRange;
    sections: AnalyticsSectionResult[] | Record<string, AnalyticsSectionResult>;
    partial: boolean;
    success?: boolean;
    generatedAt?: string;
}

export declare function resolveAnalyticsRange(options?: AnalyticsRangeOptions): AnalyticsRange;
export declare function buildAnalyticsRequestSpecs(range: AnalyticsRange): AnalyticsRequestSpec[];
export declare function unwrapAnalyticsResult(payload: unknown): AnalyticsSourceObject;
export declare function metricArrayToObject(values: unknown): AnalyticsMetricValues;
export declare function normalizeAnalyticsSection(
    spec: AnalyticsRequestSpec,
    payload: unknown,
): AnalyticsSectionSuccess;
export declare function summarizeAnalyticsReport(report?: Partial<AnalyticsReport> | null): string;
