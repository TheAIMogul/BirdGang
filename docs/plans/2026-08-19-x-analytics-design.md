# X Analytics Command Design

## Goal

Add a read-only `birdgang analytics` command that retrieves every analytics
surface observed in the supplied X Analytics HAR while reusing BirdGang's
existing authenticated session. The shorter `bird analytics` executable alias
must behave identically.

The HAR is reference material only. BirdGang must never read it at runtime,
copy its cookies or authorization headers, or commit any HAR-derived secrets.

## Command interface

The canonical command is:

```bash
birdgang analytics
```

It reports the previous 28 days by default. Users may override the range with
either a relative period or explicit boundaries:

```bash
birdgang analytics --period 24h
birdgang analytics --period 7d
birdgang analytics --from 2026-08-01 --to 2026-08-19
birdgang analytics --period 24h --json
```

`--period` and `--from`/`--to` are mutually exclusive. Explicit ranges require
both boundaries. Human-readable terminal output is the default; `--json`
returns the complete normalized report.

## Analytics coverage

The command requests all analytics surfaces captured successfully in the HAR:

- Account overview and daily time-series metrics
- Per-post content metrics
- Audience demographics and engagement breakdowns
- Media and video time-series metrics, including watch time and completion
- Estimated revenue fields when X returns them
- Video inventory
- Live-video overview
- Spaces overview

The requested metric set includes impressions, engagements, likes, bookmarks,
shares, follows, replies, reposts, profile visits, detail expands, URL clicks,
hashtag clicks, permalink clicks, video views, playback milestones, and watch
time where supported by the corresponding endpoint.

## Architecture

Add an analytics feature mixin to the existing `TwitterClient` composition.
The mixin owns analytics query IDs, date-variable construction, read-only
GraphQL requests, response parsing, and normalization. It uses the same
`auth_token`, `ct0`, bearer header, timeout behavior, and base request headers
as the rest of BirdGang.

Add a dedicated CLI command module that:

1. Resolves BirdGang credentials through the existing CLI context.
2. Parses and validates the requested time range.
3. Calls the analytics client once for the complete report.
4. Renders either a concise human summary or structured JSON.

Analytics query IDs are added to the existing query-ID registry so BirdGang's
self-healing refresh mechanism can update them when X rotates operation IDs.

## Data flow

The command calculates one UTC reporting window and derives the timestamp
formats required by each analytics operation. Independent read-only requests
run concurrently. Each successful response is normalized into a stable report
section while preserving relevant raw metric names and values.

The report contains:

- Authenticated account identity
- Requested range and generation timestamp
- One section per analytics surface
- Per-section status and normalized data
- A top-level `partial` flag when only some sections succeed

No analytics response or credential is persisted unless the user explicitly
redirects CLI output themselves.

## Error handling

Credential failures stop the command with a clear authentication error.
Invalid ranges fail before any network request. Endpoint failures are isolated:
successful sections remain available and failed sections include sanitized
status/error information without response headers, cookies, or tokens.

The process exits successfully for a complete report, nonzero when every
analytics section fails, and reports partial success clearly when only some
sections fail.

## Testing

Offline tests cover:

- Default 28-day range and relative periods such as `24h`
- Explicit `--from`/`--to` ranges and invalid combinations
- Analytics request URLs, query variables, and required header reuse
- Parsing and normalization of every observed response shape
- Missing optional fields and empty datasets
- HTTP, GraphQL, authentication, and partial-failure behavior
- Human and JSON output contracts

Tests use sanitized fixtures derived from response schemas, never the HAR or
real account data. After offline tests pass, a read-only live smoke test runs
`birdgang analytics --period 24h` against the configured X session.

