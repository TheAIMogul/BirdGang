import type {
    AnalyticsAudienceData,
    AnalyticsContentData,
    AnalyticsLiveData,
    AnalyticsMediaData,
    AnalyticsPost,
    AnalyticsReport,
    AnalyticsSpacesData,
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
    AnalyticsLiveData as TwitterClientAnalyticsLiveData,
    AnalyticsMediaData as TwitterClientAnalyticsMediaData,
    AnalyticsPost as TwitterClientAnalyticsPost,
    AnalyticsSpacesData as TwitterClientAnalyticsSpacesData,
    AnalyticsVideoData as TwitterClientAnalyticsVideoData,
} from '../dist/lib/twitter-client.js';
import { summarizeAnalyticsReport } from '../dist/lib/twitter-client-analytics.js';
import type { CookieSource } from '../dist/lib/cookies.js';
import {
    FALLBACK_QUERY_IDS,
    type OperationName,
} from '../dist/lib/twitter-client-constants.js';
import type { TwitterClient } from '../dist/index.js';

type PublicAnalyticsData = [
    AnalyticsContentData,
    AnalyticsLiveData,
    AnalyticsMediaData,
    AnalyticsPost,
    AnalyticsVideoData,
    TwitterClientAnalyticsContentData,
    TwitterClientAnalyticsLiveData,
    TwitterClientAnalyticsMediaData,
    TwitterClientAnalyticsPost,
    TwitterClientAnalyticsSpacesData,
    TwitterClientAnalyticsVideoData,
];

export function consumeAnalyticsReport(
    report: AnalyticsReport,
    publicData: PublicAnalyticsData,
): string {
    void publicData;
    return summarizeAnalyticsReport(report);
}

export function consumeAnalyticsInventory(report: AnalyticsReport): [number, number] {
    if (!report.sections.live.ok || !report.sections.spaces.ok) {
        return [0, 0];
    }
    const liveItems: AnalyticsLiveData['items'] = report.sections.live.data.items;
    const spacesItems: AnalyticsSpacesData['items'] = report.sections.spaces.data.items;
    return [liveItems.length, spacesItems.length];
}

const observedAudienceRow: AnalyticsAudienceData['organicTimeSeries'][number] = {
    timestamp: { iso8601_time: '2026-08-19T00:00:00.000Z' },
    metric_values: [{ metric_type: 'Likes', metric_value: 30 }],
};
export const observedAudienceMetricType: string | undefined =
    observedAudienceRow.metric_values?.[0]?.metric_type;

const analyticsOperation: OperationName = 'accountOverviewDailyQuery';
const analyticsFallback: string = FALLBACK_QUERY_IDS[analyticsOperation];

export async function consumeAnalyticsClient(client: TwitterClient): Promise<string> {
    await client.getAnalytics({ period: '24h' });
    return analyticsFallback;
}

const analyticsCommandOptions: AnalyticsCommandOptions = { period: '24h', json: true };
export const cometCookieSource: CookieSource = 'comet';
export const cometAnalyticsGlobalOptions: AnalyticsCommandGlobalOptions = {
    cookieSource: [cometCookieSource],
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
