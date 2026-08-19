import type {
    AnalyticsContentData,
    AnalyticsMediaData,
    AnalyticsPost,
    AnalyticsReport,
    AnalyticsVideoData,
} from '../dist/index.js';
import {
    type AnalyticsCommandDependencies,
    type AnalyticsCommandGlobalOptions,
    type AnalyticsCommandOptions,
    runAnalyticsCommand,
    validateAnalyticsCommandOptions,
} from '../dist/commands/analytics.js';
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

const analyticsCommandOptions: AnalyticsCommandOptions = { period: '24h', json: true };
export const cometAnalyticsGlobalOptions: AnalyticsCommandGlobalOptions = {
    cookieSource: ['comet'],
};
const analyticsCommandRange = validateAnalyticsCommandOptions(
    analyticsCommandOptions,
    Date.parse('2026-08-19T16:00:00.000Z'),
);

export async function consumeAnalyticsCommand(
    dependencies: AnalyticsCommandDependencies,
): Promise<number> {
    void analyticsCommandRange.fromIso;
    return runAnalyticsCommand(analyticsCommandOptions, dependencies);
}
