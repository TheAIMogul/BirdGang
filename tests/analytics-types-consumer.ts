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
