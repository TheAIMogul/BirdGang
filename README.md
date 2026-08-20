<h1 align="center">BirdGang 🐦‍⬛</h1>

<p align="center"><b>A fast, scriptable command line for X / Twitter.</b><br>
Read, post, reply, search, download media, inspect account analytics, and pull AI trend summaries — straight from your terminal, using your own browser session. No paid API, no developer account.</p>

---

## What is BirdGang?

BirdGang is a terminal-first X/Twitter client. It talks to X's internal web GraphQL API using the cookies already in your browser, so anything you can see while logged in, you can script:

```bash
birdgang whoami                              # who am I logged in as?
birdgang read https://x.com/jack/status/20   # read any tweet
birdgang search "from:nasa filter:images"    # search
birdgang tweet "shipped 🚀"                   # post
birdgang download <tweet-url> -o ~/Downloads  # save the media
birdgang grok-trends                          # what's trending + why (Grok summaries)
```

Everything prints clean text by default and structured JSON with `--json`, so it pipes nicely into `jq`, scripts, and agents.

> **License.** MIT — see [`LICENSE`](./LICENSE). Built and maintained by [@TheAIMogul](https://github.com/TheAIMogul). Installs as `birdgang` only.

## Features

- **`download`** — save a tweet's photos, videos, and GIFs to disk (resumable, original-resolution).
- **`analytics`** — inspect authenticated account, content, audience, media, video, live, and Spaces performance.
- **`grok-trends`** — the latest trends *with* X's AI ("Grok") explanation of why each is trending.
- **Native Comet cookie source** — reads a live session from Comet (Perplexity's Chromium browser), tried first by default, so a fresh Comet login wins over a stale one in another browser.
- **`t.co` link expansion** — tweet text shows real URLs instead of opaque `t.co/...` shorteners, everywhere.
- **Profile enrichment** — `following`/`followers` surface bio handles, domains, companies, and org affiliation badges.
- **Tougher rate-limit handling** — backoff now honors X's `x-rate-limit-reset` header, not just `Retry-After`.
- **Self-healing query IDs** — X rotates its GraphQL query IDs; BirdGang auto-discovers fresh ones and caches them.

## Install

BirdGang isn't published to npm. Install from this repo:

```bash
# Global install straight from GitHub — gives you `birdgang`
npm install -g github:TheAIMogul/BirdGang

# …or clone and run the built CLI directly
git clone https://github.com/TheAIMogul/BirdGang.git
cd BirdGang
node dist/cli.js whoami
```

Requires **Node 22+** (developed on Node 26). The repo ships the compiled `dist/` build, so there's no build step to install.

## Authentication

BirdGang reads your existing X login cookies (`auth_token` + `ct0`) from your browser's cookie store — no passwords, no tokens to paste. Supported sources, tried in this default order: **Comet**, **Safari**, **Chrome/Chromium** (Arc, Brave, etc.), and **Firefox**. Comet is tried first so a fresh Comet session beats a stale token elsewhere.

```bash
birdgang whoami                              # auto-detects a logged-in browser (Comet first)
birdgang --cookie-source chrome whoami       # force a specific browser
birdgang --chrome-profile "Profile 1" whoami # pick a Chrome/Comet profile
birdgang --firefox-profile default-release whoami
```

You can also pass cookies explicitly when scripting:

```bash
birdgang --auth-token "$AUTH_TOKEN" --ct0 "$CT0" whoami
```

## Quickstart

```bash
# Identity
birdgang whoami

# Read
birdgang read https://x.com/user/status/1234567890123456789
birdgang 1234567890123456789 --json          # bare ID/URL is shorthand for `read`
birdgang thread <id>                         # full conversation thread
birdgang replies <id> --max-pages 3 --json

# Search & mentions
birdgang search "from:MicahBerkley" -n 10
birdgang mentions -n 5
birdgang mentions --user @MicahBerkley -n 5

# Timelines
birdgang home -n 20                          # For You
birdgang home --following -n 20              # Following feed
birdgang user-tweets @nasa -n 50 --json
birdgang list-timeline https://x.com/i/lists/123 --all --json

# Post & engage
birdgang tweet "hello from BirdGang"
birdgang reply <id> "nice thread"
birdgang tweet "with a pic" --media ./photo.jpg --alt "a sunset"

# Social graph
birdgang following -n 20
birdgang followers --user 12345678 -n 10
birdgang follow @someone
birdgang unfollow @someone

# Bookmarks & likes
birdgang bookmarks --all --json
birdgang unbookmark <id>
birdgang likes -n 5
```

## Featured commands

### `download` — save a tweet's media

Downloads the photos, videos, and animated GIFs on a tweet. Videos use the highest-bitrate MP4 variant; photos are fetched at original resolution. Downloads resume if interrupted (re-run the same command), write atomically, and back off on rate limits.

```bash
birdgang download https://x.com/user/status/1234567890123456789
birdgang dl <id> -o ~/Downloads          # alias + output directory
birdgang download <id> --videos-only     # videos/GIFs only
birdgang download <id> --photos-only     # photos only (original resolution)
birdgang download <id> --include-quoted  # also grab a quoted tweet's media
birdgang download <id> --json            # JSON manifest of saved files
```

### `grok-trends` — trends with their AI summaries

X's trend pages include a Grok-generated summary of *why* something is trending. BirdGang surfaces it from the CLI:

```bash
birdgang grok-trends            # latest trends + Grok summaries
birdgang grok-trends -n 5       # cap the count
birdgang grok-trends --json     # structured output
birdgang trend-summaries        # alias
```

### `news` — AI-curated headlines

```bash
birdgang news --ai-only -n 20
birdgang news --sports --entertainment -n 15
birdgang news --with-tweets --tweets-per-item 3 -n 10
birdgang news --json-full --ai-only -n 10   # includes raw API response
```

Tab filters (combinable): `--for-you`, `--news-only`, `--sports`, `--entertainment`, `--trending-only`. By default it pulls For You + News + Sports + Entertainment and de-duplicates headlines.

### `analytics` — authenticated account reporting

`birdgang analytics` is the canonical analytics command; the shorter `bird analytics` executable remains an alias. The default report covers the last 28 days, with rolling-period and explicit date-range overrides:

```bash
birdgang analytics                    # last 28 days
birdgang analytics --period 24h       # rolling 24 hours
birdgang analytics --from 2026-08-01 --to 2026-08-19
birdgang analytics --period 7d --json
```

Reports include account totals and daily trends; content and per-post performance; audience activity, demographics, and location; media and video views, watch time, retention, and revenue when X makes those metrics available; and live-video and Spaces activity. The default human-readable output is a concise terminal summary. Add `--json` for the complete structured report, including section-level errors for automation and downstream analysis.

Analytics requests are read-only and reuse the authenticated X session resolved by BirdGang. Independent sections are fetched separately, so available data is still returned when another section fails. A partial report remains successful; if every analytics request fails, the command exits unsuccessfully. Section and metric availability depends on what X exposes to the authenticated account.

## JSON output

Add `--json` for structured output from: `analytics`, `read`, `replies`, `thread`, `search`, `mentions`, `bookmarks`, `likes`, `following`, `followers`, `about`, `lists`, `list-timeline`, `home`, `user-tweets`, `news`, `grok-trends`, `query-ids`, and `download`. Add `--json-full` where offered to include the raw API response under `_raw`.

```bash
birdgang search "from:nasa" -n 5 --json | jq '.[].text'
birdgang download <id> --json | jq '.downloaded[].file'
```

## Library usage

BirdGang is also importable — the same GraphQL client the CLI uses:

```ts
import { TwitterClient, resolveCredentials } from 'birdgang';

const { cookies } = await resolveCredentials({ cookieSource: 'comet' });
const client = new TwitterClient({ cookies });

const search = await client.search('from:MicahBerkley', 50);
const news = await client.getNews(10, { aiOnly: true });
```

## Configuration

BirdGang reads JSON5 config from `~/.config/bird/config.json5` (global) and `./.birdrc.json5` (per-project). Supported keys: `chromeProfile`, `chromeProfileDir`, `firefoxProfile`, `cookieSource`, `cookieTimeoutMs`, `timeoutMs`, `quoteDepth`.

Environment variables: `NO_COLOR`, `BIRD_TIMEOUT_MS`, `BIRD_COOKIE_TIMEOUT_MS`, `BIRD_QUOTE_DEPTH`, `BIRD_QUERY_IDS_CACHE`.

Self-healing GraphQL query IDs are cached at `~/.config/bird/query-ids-cache.json` (24h TTL). Force a refresh:

```bash
birdgang query-ids --fresh
```

## Command reference

| Command | Description |
|---|---|
| `whoami` | Show the logged-in account |
| `read <id\|url>` · `<id\|url>` | Read a tweet (bare ID/URL is shorthand) |
| `thread <id\|url>` | Full conversation thread |
| `replies <id\|url>` | Replies to a tweet (paginated) |
| `search "<query>"` | Search tweets |
| `mentions` | Your mentions (or `--user`'s) |
| `home` | Home timeline (`--following` for the Following feed) |
| `user-tweets <@user>` | A user's profile timeline |
| `list-timeline <id\|url>` | Tweets from a List |
| `lists` | Your Lists |
| `tweet "<text>"` | Post a tweet (`--media`, `--alt`) |
| `reply <id\|url> "<text>"` | Reply to a tweet |
| `following` · `followers` | Social graph (with bio/affiliation enrichment) |
| `follow` · `unfollow` | Manage follows |
| `bookmarks` · `unbookmark` | Bookmarks |
| `likes` | Your liked tweets |
| `news` | AI-curated headlines |
| `grok-trends` · `trend-summaries` | Trends with Grok summaries |
| `analytics` | Authenticated account analytics (last 28 days by default) |
| `download` · `dl` | Save a tweet's media to disk |
| `about <@user>` | Account origin/location metadata |
| `query-ids [--fresh]` | Inspect/refresh cached GraphQL query IDs |
| `help [command]` | Help for any command |

Run `birdgang <command> --help` for the full flag list of any command.

## Development & tests

```bash
npm test                       # feature tests + analytics tests + strict type check
node dist/cli.js --help        # browse the CLI
node dist/cli.js analytics --help
```

The repo ships compiled `dist/` ESM; new features are added as hand-authored modules under `dist/` and wired into `dist/cli/program.js`.

## Disclaimer

BirdGang uses X/Twitter's **undocumented** web GraphQL API with cookie auth. X can change endpoints, rotate query IDs, and adjust anti-bot behavior at any time — **expect things to break without notice.** Use responsibly and within X's terms; you are responsible for how you use your own account.

## License

MIT. Maintained by [@TheAIMogul](https://github.com/TheAIMogul). See [`LICENSE`](./LICENSE).
