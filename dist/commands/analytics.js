import { TwitterClient } from '../lib/twitter-client.js';
import {
    AUDIENCE_METRICS,
    resolveAnalyticsRange,
    summarizeAnalyticsReport,
} from '../lib/twitter-client-analytics.js';

const STABLE_ANALYTICS_SECTIONS = Object.freeze([
    'account',
    'audience',
    'content',
    'media',
    'video',
    'live',
    'spaces',
]);

function sanitizeCommandMessage(value, fallback = 'Unknown analytics error') {
    const message = typeof value === 'string' && value.trim() !== '' ? value : fallback;
    const sanitized = message
        .replace(/https:\/\/x\.com\/i\/api\/graphql\/[^\s?]+(?:\?[^\s]*)?/gi, '[X Analytics endpoint]')
        .replace(/\b(authorization)\b\s*([:=]\s*)Bearer\s+(?:"[^"]*"|'[^']*'|[^\s,;}\]"']+)/gi, '$1$2[REDACTED]')
        .replace(/(["']?)(auth[_-]?token|ct0|(?:x-)?csrf(?:-token)?|authorization|cookie(?:header)?|set-cookie)\1\s*([:=]\s*)(?!\[REDACTED\])(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi, '$1$2$1$3[REDACTED]')
        .replace(/\bBearer\s+(?:"[^"]*"|'[^']*'|[^\s,;}\]"']+)/gi, 'Bearer [REDACTED]')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return sanitized.length > 240 ? `${sanitized.slice(0, 239)}…` : sanitized;
}

function errorMessage(error, fallback) {
    if (error instanceof Error) {
        return sanitizeCommandMessage(error.message, fallback);
    }
    if (typeof error === 'string') {
        return sanitizeCommandMessage(error, fallback);
    }
    return fallback;
}

function failedAnalyticsItems(report) {
    const failures = [];
    const sections = report?.sections;
    if (!sections || typeof sections !== 'object' || Array.isArray(sections)) {
        return failures;
    }

    for (const sectionName of STABLE_ANALYTICS_SECTIONS) {
        const section = sections[sectionName];
        if (sectionName === 'audience' && section?.metrics && typeof section.metrics === 'object') {
            for (const metric of AUDIENCE_METRICS) {
                const result = section.metrics[metric];
                if (result?.ok === false) {
                    failures.push({
                        label: `audience:${metric}`,
                        error: result.error,
                    });
                }
            }
            continue;
        }
        if (section?.ok === false) {
            failures.push({ label: sectionName, error: section.error });
        }
    }
    return failures;
}

export function validateAnalyticsCommandOptions(options = {}, now = Date.now()) {
    return resolveAnalyticsRange({
        period: options.period,
        from: options.from,
        to: options.to,
        now,
    });
}

export async function runAnalyticsCommand(commandOptions = {}, dependencies) {
    const {
        ctx,
        globalOptions = {},
        now = Date.now(),
        createClient = (options) => new TwitterClient(options),
        stdout = (message) => console.log(message),
        stderr = (message) => console.error(message),
    } = dependencies;

    try {
        validateAnalyticsCommandOptions(commandOptions, now);
    }
    catch (error) {
        stderr(`${ctx.p('err')}${errorMessage(error, 'Invalid analytics reporting range')}`);
        return 1;
    }

    const timeoutMs = ctx.resolveTimeoutFromOptions(globalOptions);
    let credentials;
    try {
        credentials = await ctx.resolveCredentialsFromOptions(globalOptions);
    }
    catch (error) {
        stderr(`${ctx.p('err')}Could not resolve credentials: ${errorMessage(error, 'Credential lookup failed')}`);
        return 1;
    }

    for (const warning of credentials.warnings) {
        stderr(`${ctx.p('warn')}${sanitizeCommandMessage(warning, 'Credential lookup warning')}`);
    }
    if (!credentials.cookies.authToken || !credentials.cookies.ct0) {
        stderr(`${ctx.p('err')}Missing required credentials. Provide --auth-token and --ct0, or configure a supported browser profile.`);
        return 1;
    }

    let report;
    try {
        const client = createClient({ cookies: credentials.cookies, timeoutMs });
        report = await client.getAnalytics({
            period: commandOptions.period,
            from: commandOptions.from,
            to: commandOptions.to,
        });
    }
    catch (error) {
        stderr(`${ctx.p('err')}Failed to fetch X Analytics: ${errorMessage(error, 'Analytics request failed')}`);
        return 1;
    }

    if (!report || report.success !== true) {
        stderr(`${ctx.p('err')}${sanitizeCommandMessage(
            report?.error,
            'All analytics report sections failed. Check your X cookies, sign in again if needed, and retry.',
        )}`);
        return 1;
    }

    stdout(commandOptions.json
        ? JSON.stringify(report, null, 2)
        : summarizeAnalyticsReport(report));

    for (const failure of failedAnalyticsItems(report)) {
        stderr(`${ctx.p('warn')}Analytics ${failure.label} failed: ${sanitizeCommandMessage(failure.error)}`);
    }
    return 0;
}

export function registerAnalyticsCommand(program, ctx) {
    program
        .command('analytics')
        .description('Get authenticated X account analytics')
        .option('--period <duration>', 'Relative reporting period, such as 24h, 7d, or 28d')
        .option('--from <date>', 'Reporting range start (ISO date or date-time)')
        .option('--to <date>', 'Reporting range end (ISO date or date-time)')
        .option('--json', 'Output the complete report as JSON')
        .action(async (cmdOpts) => {
        const exitCode = await runAnalyticsCommand(cmdOpts, {
            ctx,
            globalOptions: program.opts(),
        });
        if (exitCode !== 0) {
            process.exitCode = exitCode;
        }
    });
}
