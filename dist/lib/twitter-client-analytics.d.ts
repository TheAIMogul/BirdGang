import type { AbstractConstructor, Mixin, TwitterClientBase } from './twitter-client-base.js';

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

export type AnalyticsOptions = AnalyticsRangeOptions;

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
    metricTotals: AnalyticsMetricValues;
}

export interface AnalyticsPost extends AnalyticsSourceObject {
    id: string;
    text: string;
    createdAt: unknown;
    media: unknown[];
    metricTotals: AnalyticsMetricValues;
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

export interface AnalyticsAudienceReportData extends AnalyticsSourceObject {
    byMetric: Partial<Record<AudienceMetric, AnalyticsAudienceData>>;
    organicTimeSeries: AnalyticsMetricRow[];
    demographics: AnalyticsSourceObject[];
    countries: AnalyticsSourceObject[];
}

export interface AnalyticsMediaData extends AnalyticsSourceObject {
    metricTimeSeries: AnalyticsMetricRow[];
    metricTotals: AnalyticsMetricValues;
}

export interface AnalyticsVideoData extends AnalyticsSourceObject {
    mediaInventory: AnalyticsSourceObject[];
    metricTotals: AnalyticsMetricValues;
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

export type AnalyticsAudienceMetricResults = Record<
    AudienceMetric,
    AnalyticsSectionResult<AnalyticsAudienceData>
>;

export interface AnalyticsAudienceSectionSuccess {
    ok: true;
    section: 'audience';
    operation: 'audienceOverviewDataQuery';
    partial: boolean;
    metrics: AnalyticsAudienceMetricResults;
    data: AnalyticsAudienceReportData;
}

export interface AnalyticsAudienceSectionFailure {
    ok: false;
    section: 'audience';
    operation: 'audienceOverviewDataQuery';
    error: string;
    metrics: AnalyticsAudienceMetricResults;
}

export type AnalyticsAudienceSection = AnalyticsAudienceSectionSuccess | AnalyticsAudienceSectionFailure;

export interface AnalyticsReportSections {
    account: AnalyticsSectionResult<AnalyticsAccountData>;
    audience: AnalyticsAudienceSection;
    content: AnalyticsSectionResult<AnalyticsContentData>;
    media: AnalyticsSectionResult<AnalyticsMediaData>;
    video: AnalyticsSectionResult<AnalyticsVideoData>;
    live: AnalyticsSectionResult;
    spaces: AnalyticsSectionResult;
}

export interface AnalyticsResultCounts {
    total: number;
    succeeded: number;
    failed: number;
}

export interface AnalyticsAccountIdentity {
    id?: string;
    username?: string;
    name?: string;
}

export interface AnalyticsReport extends AnalyticsSourceObject {
    success: boolean;
    partial: boolean;
    generatedAt: string;
    range: AnalyticsRange;
    account?: AnalyticsAccountIdentity;
    sections: AnalyticsReportSections;
    sectionCounts: AnalyticsResultCounts;
    requestCounts: AnalyticsResultCounts;
    error?: string;
}

export interface AnalyticsReportLike extends AnalyticsSourceObject {
    range?: AnalyticsRange;
    sections?: AnalyticsSectionResult[] | Record<string, AnalyticsSectionResult | AnalyticsAudienceSection>;
    partial?: boolean;
    success?: boolean;
    generatedAt?: string;
}

export interface TwitterClientAnalyticsMethods {
    getAnalytics(options?: AnalyticsOptions): Promise<AnalyticsReport>;
}

export declare function resolveAnalyticsRange(options?: AnalyticsRangeOptions): AnalyticsRange;
export declare function buildAnalyticsRequestSpecs(range: AnalyticsRange): AnalyticsRequestSpec[];
export declare function unwrapAnalyticsResult(payload: unknown): AnalyticsSourceObject;
export declare function metricArrayToObject(values: unknown): AnalyticsMetricValues;
export declare function normalizeAnalyticsSection(
    spec: AnalyticsRequestSpec,
    payload: unknown,
): AnalyticsSectionSuccess;
export declare function withAnalytics<TBase extends AbstractConstructor<TwitterClientBase>>(
    Base: TBase,
): Mixin<TBase, TwitterClientAnalyticsMethods>;
export declare function summarizeAnalyticsReport(report?: AnalyticsReportLike | null): string;
