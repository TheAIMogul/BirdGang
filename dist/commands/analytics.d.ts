import type { Command } from 'commander';
import type { TwitterCookies } from '../lib/cookies.js';
import type {
    AnalyticsRange,
    TwitterClient,
    TwitterClientOptions,
} from '../lib/twitter-client.js';

export interface AnalyticsCommandOptions {
    period?: string;
    from?: string;
    to?: string;
    json?: boolean;
}

export type AnalyticsCommandGlobalOptions =
    {
        authToken?: string;
        ct0?: string;
        chromeProfile?: string;
        chromeProfileDir?: string;
        firefoxProfile?: string;
        cookieSource?: Array<'comet' | 'safari' | 'chrome' | 'firefox'>;
        cookieTimeout?: string | number;
        timeout?: string | number;
    };

export interface AnalyticsCommandContext {
    p(kind: 'warn' | 'err'): string;
    resolveTimeoutFromOptions(options: {
        timeout?: string | number;
    }): number | undefined;
    resolveCredentialsFromOptions(options: AnalyticsCommandGlobalOptions): Promise<{
        cookies: TwitterCookies;
        warnings: string[];
    }>;
}

export interface AnalyticsCommandDependencies {
    ctx: AnalyticsCommandContext;
    globalOptions?: AnalyticsCommandGlobalOptions;
    now?: number;
    createClient?: (options: TwitterClientOptions) => Pick<TwitterClient, 'getAnalytics'>;
    stdout?: (message: string) => void;
    stderr?: (message: string) => void;
}

export declare function validateAnalyticsCommandOptions(
    options?: AnalyticsCommandOptions,
    now?: number,
): AnalyticsRange;

export declare function runAnalyticsCommand(
    commandOptions: AnalyticsCommandOptions | undefined,
    dependencies: AnalyticsCommandDependencies,
): Promise<number>;

export declare function registerAnalyticsCommand(program: Command, ctx: AnalyticsCommandContext): void;
