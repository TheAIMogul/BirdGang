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

/** Placeholder normalized section shape completed by the response-normalization task. */
export interface AnalyticsSectionResult<T = unknown> {
    ok: boolean;
    operation: AnalyticsOperation;
    data?: T;
    metric?: AudienceMetric;
    error?: string;
}

/** Placeholder complete report shape completed by the analytics client task. */
export interface AnalyticsReport {
    range: AnalyticsRange;
    sections: AnalyticsSectionResult[];
    partial: boolean;
}

/** Placeholder client surface implemented by the analytics client mixin task. */
export interface TwitterClientAnalyticsMethods {
    getAnalytics(options?: AnalyticsRangeOptions): Promise<AnalyticsReport>;
}

export declare function resolveAnalyticsRange(options?: AnalyticsRangeOptions): AnalyticsRange;
export declare function buildAnalyticsRequestSpecs(range: AnalyticsRange): AnalyticsRequestSpec[];
