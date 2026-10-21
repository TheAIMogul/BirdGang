import { getFeatureOverridesSnapshot, refreshFeatureOverridesCache, } from '../lib/runtime-features.js';
import { runtimeQueryIds } from '../lib/runtime-query-ids.js';
import { TARGET_QUERY_ID_OPERATIONS } from '../lib/twitter-client-constants.js';
// x.com only serves its legacy client bundles (where the query IDs live) to logged-in sessions.
async function resolveDiscoveryCookieHeader(program, ctx) {
    try {
        const { cookies, warnings } = await ctx.resolveCredentialsFromOptions(program.opts());
        for (const warning of warnings) {
            console.error(`${ctx.p('warn')}${warning}`);
        }
        return cookies.authToken && cookies.ct0 ? cookies.cookieHeader : undefined;
    }
    catch {
        return undefined;
    }
}
function countFeatureOverrides(overrides) {
    let count = 0;
    if (overrides.global) {
        count += Object.keys(overrides.global).length;
    }
    if (overrides.sets) {
        for (const setOverrides of Object.values(overrides.sets)) {
            count += Object.keys(setOverrides).length;
        }
    }
    return count;
}
export function registerQueryIdsCommand(program, ctx) {
    program
        .command('query-ids')
        .description('Show or refresh cached Twitter GraphQL query IDs')
        .option('--json', 'Output as JSON')
        .option('--fresh', 'Force refresh (downloads X client bundles)', false)
        .action(async (cmdOpts) => {
        let refreshError;
        if (cmdOpts.fresh) {
            const cookieHeader = await resolveDiscoveryCookieHeader(program, ctx);
            console.error(`${ctx.p('info')}Refreshing GraphQL query IDs…`);
            try {
                await runtimeQueryIds.refresh(TARGET_QUERY_ID_OPERATIONS, { force: true, cookieHeader });
            }
            catch (error) {
                refreshError = error instanceof Error ? error.message : String(error);
                process.exitCode = 1;
                console.error(`${ctx.p('warn')}Could not refresh query IDs: ${refreshError}`);
                console.error(`${ctx.p('info')}Keeping the existing query IDs.`);
            }
            console.error(`${ctx.p('info')}Refreshing feature overrides…`);
            await refreshFeatureOverridesCache();
        }
        const featureSnapshot = getFeatureOverridesSnapshot();
        const info = await runtimeQueryIds.getSnapshotInfo();
        if (!info) {
            if (cmdOpts.json) {
                console.log(JSON.stringify({
                    cached: false,
                    cachePath: runtimeQueryIds.cachePath,
                    ...(refreshError ? { refreshError } : {}),
                    featuresPath: featureSnapshot.cachePath,
                    features: featureSnapshot.overrides,
                }, null, 2));
                return;
            }
            console.log(`${ctx.p('info')}No cached query IDs; using the IDs bundled with BirdGang.`);
            console.log(`features_path: ${featureSnapshot.cachePath}`);
            return;
        }
        if (cmdOpts.json) {
            console.log(JSON.stringify({
                cached: true,
                cachePath: info.cachePath,
                fetchedAt: info.snapshot.fetchedAt,
                isFresh: info.isFresh,
                ageMs: info.ageMs,
                ids: info.snapshot.ids,
                discovery: info.snapshot.discovery,
                ...(refreshError ? { refreshError } : {}),
                featuresPath: featureSnapshot.cachePath,
                features: featureSnapshot.overrides,
            }, null, 2));
            return;
        }
        console.log(`${ctx.p('ok')}GraphQL query IDs cached`);
        console.log(`path: ${info.cachePath}`);
        console.log(`fetched_at: ${info.snapshot.fetchedAt}`);
        console.log(`fresh: ${info.isFresh ? 'yes' : 'no'}`);
        console.log(`ops: ${Object.keys(info.snapshot.ids).length}`);
        console.log(`features_path: ${featureSnapshot.cachePath}`);
        console.log(`features: ${countFeatureOverrides(featureSnapshot.overrides)}`);
    });
}
//# sourceMappingURL=query-ids.js.map