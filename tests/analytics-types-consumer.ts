import type {
    AnalyticsContentData,
    AnalyticsMediaData,
    AnalyticsPost,
    AnalyticsReport,
    AnalyticsVideoData,
} from '../dist/index.js';
import type {
    AnalyticsContentData as TwitterClientAnalyticsContentData,
    AnalyticsMediaData as TwitterClientAnalyticsMediaData,
    AnalyticsPost as TwitterClientAnalyticsPost,
    AnalyticsVideoData as TwitterClientAnalyticsVideoData,
} from '../dist/lib/twitter-client.js';
import { summarizeAnalyticsReport } from '../dist/lib/twitter-client-analytics.js';
import {
    FALLBACK_QUERY_IDS,
    type OperationName,
} from '../dist/lib/twitter-client-constants.js';
import type { TwitterClient } from '../dist/index.js';

type PublicAnalyticsData = [
    AnalyticsContentData,
    AnalyticsMediaData,
    AnalyticsPost,
    AnalyticsVideoData,
    TwitterClientAnalyticsContentData,
    TwitterClientAnalyticsMediaData,
    TwitterClientAnalyticsPost,
    TwitterClientAnalyticsVideoData,
];

export function consumeAnalyticsReport(
    report: AnalyticsReport,
    publicData: PublicAnalyticsData,
): string {
    void publicData;
    return summarizeAnalyticsReport(report);
}

const analyticsOperation: OperationName = 'accountOverviewDailyQuery';
const analyticsFallback: string = FALLBACK_QUERY_IDS[analyticsOperation];

export async function consumeAnalyticsClient(client: TwitterClient): Promise<string> {
    await client.getAnalytics({ period: '24h' });
    return analyticsFallback;
}
