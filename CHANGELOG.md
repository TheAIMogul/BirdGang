# Changelog

BirdGang versioning starts at **1.0.0**. Entries below `1.0.0` are earlier
release history, kept for provenance.

## Unreleased — X Chat (encrypted DMs): transport and `birdgang chat` commands

### Added
- `birdgang chat` — read and write X Chat (end-to-end encrypted DMs) using X's own
  `@xdevplatform/chat-xdk` crypto layer (groundwork committed at 1.1.3): `unlock --remember`,
  `forget`, `inbox`, `read`, `send` (`--media`, `--ttl <seconds>`, `--no-notify`), `reply`,
  `react [--remove]`, `edit`, and `dl`, each with `--json`. `send`/`reply` accept `@handle` to
  start a new encrypted conversation (first-contact key change, then the message).
- `dist/lib/xchat/transport.js` — the chat network transport over the web GraphQL chat ops:
  own key record with fresh Juicebox tokens, paged inbox, a conversation's event history,
  participant keys in batch, message/key-change writes, and encrypted media upload
  (initialize → ton.x.com segments → finalize) and download. It moves bytes only and never
  imports the crypto layer.
- `dist/lib/xchat/ops.json` — the 16 chat GraphQL operation ids X's web client ships, with a
  24h runtime cache (`~/.config/bird/xchat-ops.json`) re-synced from X's public embed manifest;
  a rejected id (HTTP 404 or `PersistedQueryNotFound`) self-heals exactly like BirdGang's
  timeline query ids, and a CSRF expiry (403 / code 353) retries once with the fresh `ct0`.
- `tests/xchat-transport-tests.mjs` — 24 offline tests (sample-shaped fixtures, fake fetch).
- `docs/plans/2026-10-21-x-chat-transport.md` — route decision, resolved handover questions
  (media-upload message-id linkage: X's official upload API takes no message id, so the
  transport mints an unlinked session UUID), and the live-verification checklist. Writes are
  not yet live-verified; see that doc before relying on send paths.

## 1.1.3 — 2026-10-21 — self-healing query IDs work again

### Fixed
- Query-ID discovery fetched x.com anonymously. x.com now serves logged-out visitors a new Relay
  client and serves the legacy client bundles, where BirdGang's query IDs live, only to logged-in
  sessions. Discovery now sends the session cookie to x.com pages (never to the public CDN), so
  `query-ids --fresh` and the automatic refresh on a rejected ID find current IDs again. It
  refreshes every operation BirdGang knows, not just ten.
- Corrects 1.1.2, which concluded X no longer published these IDs at all. That held only for
  logged-out pages.

### Changed
- Bundled query IDs updated to the ones X's web client publishes today (16 operations). Every
  read command and analytics was verified live against them, with and without a cache. The
  retweet, unretweet, unlike and bookmark IDs are as published and were not exercised.

### Tests
- 36 feature tests, including cookie-gated discovery that never sends cookies to the CDN.

## 1.1.2 — 2026-10-21 — lists fix, query-ID refresh hardening

### Fixed
- `lists` (and list memberships / `list-timeline`) failed outright with
  `BadRequest: com.twitter.strato.serialization.DecodeException`. X now returns field-level errors
  for list banner images alongside complete list data; partial errors are tolerated whenever usable
  data is present, matching `read`/`thread` and `bookmarks`.
- `query-ids --fresh` crashed with a stack trace. X rebuilt its web client (`abs.twimg.com/x-web`,
  Relay), which no longer publishes the legacy query IDs BirdGang uses; its own IDs need different
  request variables (verified: they return HTTP 422), so they are deliberately not adopted. The
  refresh now reports the reason, keeps the existing IDs, and exits non-zero.
- A successful refresh replaced the whole query-ID cache with only the operations it found,
  dropping every other cached ID. Refreshes now merge into the existing cache.
- `lists` showed an empty owner (`Owner: @`): X now returns the owner's handle and name under
  `core` instead of `legacy`. Both are read now, matching the rest of the client.
- `birdgang about <all-digit handle>` was rewritten into `read` because `about` was missing from
  the known-command list.

### Changed
- Removed leftover `bird` references from the README, the help example, the `query-ids` hint, and
  `dist/cli.d.ts`. The README now describes query-ID handling accurately instead of promising
  self-healing discovery.
- Removed `package.json` scripts and devDependencies that pointed at tooling absent from this
  dist-only repo (`src/`, `scripts/`, bun, biome, oxlint, vitest, tsx).

### Tests
- `npm test` now runs 35 feature tests (version gate reads the top CHANGELOG entry instead of a
  hardcoded version), 79 analytics tests, and the strict analytics TypeScript consumer check.

## 1.1.1 — 2026-08-20 — drop the `bird` alias

### Removed
- The `bird` executable alias. Installing the package now provides only `birdgang` — the `bird`
  entry has been removed from `package.json`'s `bin` map, so `npm install -g` no longer creates
  it. Existing global installs with a stale `bird` symlink can remove it manually or reinstall.

### Changed
- All README usage examples now invoke `birdgang` instead of `bird`. Internal config storage
  paths (`~/.config/bird/...`) are unchanged for backward compatibility with existing configs.

## 1.1.0 — 2026-08-19 — authenticated X analytics

### Added
- `analytics` command for read-only reporting across account trends, content and per-post
  performance, audience, media/video watch time and revenue (when available), live video, and
  Spaces. The default window is the last 28 days, with `--period` and `--from`/`--to` overrides.
- Human-readable terminal summaries by default and complete structured reports with `--json`.
- Partial-result handling that preserves successful sections while reporting sanitized failures
  for unavailable analytics surfaces or individual audience metrics.

### Changed
- Analytics transport now uses authenticated, allowlisted, size-bounded X GraphQL requests with
  query-ID refresh and sanitized errors. The runtime implementation is HAR-free and does not
  depend on captured request data.
- `birdgang analytics` is the canonical command spelling; `bird analytics` remains a compatible
  executable alias. Public Comet cookie-source and analytics operation typings remain strict.

### Tests
- `npm test` now runs 26 feature tests, 79 analytics tests, and the strict analytics TypeScript
  consumer check.

## 1.0.0 — 2026-06-23 — first BirdGang release

First independent release as **BirdGang**. Installs as `birdgang`, with `bird` kept as an
alias for compatibility.

### Added
- `download` command (alias `dl`) — download a tweet's media (photos, videos, animated GIFs)
  to disk. Highest-bitrate MP4 variant selection, original-resolution photos (`?name=orig`),
  HTTP Range resume, atomic `.part`→rename, and 429-aware backoff. Flags: `-o/--out`,
  `--include-quoted`, `--photos-only`, `--videos-only`, `--json`.
- Native **Comet** (Perplexity Chromium) cookie source, tried first by default, so a live Comet
  session beats a stale token in another browser.
- Bio enrichment in `following`/`followers` — surfaces `@handles`, domains, and company mentions
  from a profile bio, plus the org affiliation badge when present.

### Changed
- Rebranded to BirdGang: new README, package renamed to `birdgang`, CLI banner shows "BirdGang".
- Tweet text now expands `t.co` short links to their real URLs (via the tweet's url entities)
  across `read`, `thread`, `replies`, `search`, timelines, etc. No-op when entities are absent.
- Rate-limit backoff now honors X's `x-rate-limit-reset` absolute-epoch header (in addition to
  `Retry-After`) before falling back to exponential backoff + jitter.

### Removed
- Orphaned build sourcemaps (`*.js.map`, `*.d.ts.map`) that referenced a `src/` tree absent from
  this dist-only repo; stale planning notes and `.DS_Store` cruft.

### Tests
- `tests/feature-tests.mjs` — 18 offline unit/integration tests (host safety, variant selection,
  backoff math, resumable downloader with injected fetch/sleep, URL expansion, bio/affiliation).

---

## Earlier release history

## 0.8.0 — 2026-01-19

### Added
- `bookmarks` thread expansion controls (`--expand-root-only`, `--author-chain`, `--author-only`, `--full-chain-only`, `--include-ancestor-branches`, `--include-parent`, `--thread-meta`, `--sort-chronological`) for richer context exports (#55) — thanks @kkretschmer2.
- `--chrome-profile-dir` to point at Chromium profile directories or cookie DB files (Arc/Brave/etc) for cookie extraction (#16) — thanks @tekumara.
- `about` command to report account origin/location metadata (#51) — thanks @pjtf93.
- `follow`/`unfollow` commands to manage follows (#54) — thanks @citizenlee.
- Twitter client now supports like/unlike/retweet/unretweet/bookmark via the engagement mixin (#53) — thanks @the-vampiire.

### Fixed
- `bookmarks` expanded JSON now preserves pagination `nextCursor`, and full-chain filtering only includes ancestor branches when requested.
- Follow/unfollow REST fallback now supports cursor pagination for followers/following (#54).
- About account live coverage now verifies data extraction paths (#51) — thanks @pjtf93.

### Tests
- Live tests now exercise engagement mutations (opt-in) (#53) — thanks @the-vampiire.

## 0.7.0 — 2026-01-12

### Added
- `home` command for the "For You" and "Following" home timelines (#31) — thanks @odysseus0.
- `news`/`trending` command for Explore tabs with AI-curated headlines (#39) — thanks @aavetis.
- `user-tweets` command to fetch a user's profile timeline (#34) — thanks @crcatala.
- `replies` and `thread` now support pagination (`--all`, `--max-pages`, `--cursor`, `--delay`) (#35) — thanks @crcatala.
- `search` now supports pagination (`--all`, `--max-pages`, `--cursor`) (#42) — thanks @pjtf93.
- `likes` now supports pagination (`--all`, `--max-pages`, `--cursor`) (#44) — thanks @jsholmes.
- `list-timeline` now supports pagination (`--all`, `--max-pages`, `--cursor`) (#30) — thanks @zheli.
- Rich text output now shows article previews, quoted tweets, and media links (#32) — thanks @odysseus0.
- Long-form article tweets now render rich Draft.js content blocks/entities (#36) — thanks @crcatala.

### Changed
- Library typing: `SearchResult` is now a discriminated union (so `error` only exists when `success: false`).

### Fixed
- Lists GraphQL feature flags updated to prevent 400s (#27) — thanks @zheli.
- Lists feature overrides now scope new GraphQL flags correctly (#50) — thanks @ryanh-ai.
- Tweet detail parsing now tolerates partial GraphQL errors when usable data exists (#48) — thanks @jsholmes.
- News output now respects `--tweets-per-item`, keeps unique IDs, and parses non-add entry instructions (#39) — thanks @aavetis.
- Following/followers pagination now guards repeat cursors and standardizes JSON output (#28) — thanks @malpern.
- Likes pagination now follows cursors and avoids stalling on duplicate pages (#12) — thanks @titouv.
- macOS cookie extraction now supports Brave keychain storage (#40) — thanks @gakonst.
- Terminal hyperlinks now sanitize control characters before emitting OSC 8 sequences (#29) — thanks @mafulafunk.
- `pnpm run build:dist` now succeeds after tightening JSON/pagination option typing in tweet output commands.

### Tests
- Following: split following/likes tests + cover cursor handling (#33) — thanks @VACInc.

## 0.6.0 — 2026-01-05

### Added
- Bookmark exports now support pagination (`--all`, `--max-pages`) with retries (#15) — thanks @Nano1337.
- `lists` + `list-timeline` commands for Twitter Lists (#21) — thanks @harperreed
- Tweet JSON output now includes media items (photos, videos, GIFs) (#14) — thanks @Hormold
- Bookmarks can resume pagination from a cursor (#26) — thanks @leonho
- `unbookmark` command to remove bookmarked tweets (#22) — thanks @mbelinky.

### Changed
- Feature flags can be overridden at runtime via `features.json` (refreshable via `query-ids`).

### Fixed
- GraphQL feature flags now include `post_ctas_fetch_enabled` to avoid 400s (#38) — thanks @philipp-spiess.

## 0.5.1 — 2026-01-01

### Changed
- `bird --help` now includes explicit “Shortcuts” and “JSON Output” sections (documents `bird <tweet-id-or-url>` shorthand + `--json`).
- Release docs now include explicit npm publish verification steps.

### Fixed
- `pnpm bird --help` now works (dev script runs the CLI entrypoint, not the library entrypoint).
- `following`/`followers` now fall back to internal v1.1 REST endpoints when GraphQL returns `404`.

### Tests
- Add root help output regression test.
- Add opt-in live CLI test suite (real GraphQL calls; skipped by default; gated via `BIRD_LIVE=1`).

## 0.5.0 — 2026-01-01

### Added
- `likes` command to list your liked tweets (thanks @swairshah).
- Quoted tweet data in JSON output + `--quote-depth` (thanks @alexknowshtml).
- `following`/`followers` commands to list users (thanks @lockmeister).

### Changed
- Query ID updater now tracks the Likes GraphQL operation.
- Query ID updater now tracks Following/Followers GraphQL operations.
- Query ID updater now tracks BookmarkFolderTimeline and keeps bookmark query IDs seeded.
- `following`/`followers` JSON user fields are now camelCase (`followersCount`, `followingCount`, `isBlueVerified`, `profileImageUrl`, `createdAt`).
- Cookie extraction timeout is now configurable (default 30s on macOS) via `--cookie-timeout` / `BIRD_COOKIE_TIMEOUT_MS` (thanks @tylerseymour).
- Search now paginates beyond 20 results when using `-n` (thanks @ryanh-ai).
- Library exports are now separated from the CLI entrypoint for easier embedding.

## 0.4.1 — 2025-12-31

### Added
- `bookmarks` command to list your bookmarked tweets.
- `bookmarks --folder-id` to fetch bookmark folders (thanks @tylerseymour).

### Changed
- Cookie extraction now uses the vendored `cookie-jar` library (drops `sqlite3` CLI + custom browser readers).
- Query ID updater now tracks the Bookmarks GraphQL operation.
- Lint rules stricter (block statements, no-negation-else, useConst/useTemplate, top-level regex, import extension enforcement).
- `pnpm lint` now runs both Biome and oxlint (type-aware).

### Tests
- Coverage thresholds raised to 90% statements/lines/functions (80% branches).
- Added targeted Twitter client coverage suites.

## 0.4.0 — 2025-12-26

### Added
- Cookie source selection: `--cookie-source safari|chrome|firefox` (repeatable) + `cookieSource` config (string or array).

### Fixed
- `tweet`/`reply`: fallback to `statuses/update.json` when GraphQL `CreateTweet` returns error 226 (“automated request”).

### Breaking
- Remove `allowSafari`/`allowChrome`/`allowFirefox` config toggles in favor of `cookieSource` ordering.

## 0.3.0 — 2025-12-26

### Added
- Safari cookie extraction (`Cookies.binarycookies`) + `allowSafari` config toggle.

### Changed
- Removed the Sweetistics engine + fallback. `bird` is GraphQL-only.
- Browser cookie fallback order: Safari → Chrome → Firefox.

### Tests
- Enforce coverage thresholds (>= 70% statements/branches/functions/lines) + expand unit coverage for version/output/Twitter client branches.

## 0.2.0 — 2025-12-26

### Added
- Output controls: `--plain`, `--no-emoji`, `--no-color` (respects `NO_COLOR`).
- `help` command: `bird help <command>`.
- Runtime GraphQL query ID refresh: `bird query-ids --fresh` (cached on disk; auto-retry on 404; override cache via `BIRD_QUERY_IDS_CACHE`).
- GraphQL media uploads via `--media` (up to 4 images/GIFs, or 1 video).

### Fixed
- CLI `--version`: read version from `package.json`/`VERSION` (no hardcoded string) + append git sha when available.

### Changed
- `mentions`: no hardcoded user; defaults to authenticated user or accepts `--user @handle`.
- GraphQL query ID updater: correctly pairs `operationName` ↔ `queryId` (CreateTweet/CreateRetweet/etc).
- `build:dist`: copies `src/lib/query-ids.json` into `dist/lib/query-ids.json` (keeps `dist/` in sync).
- `--engine graphql`: strict GraphQL-only (disables Sweetistics fallback).

## 0.1.1 — 2025-12-26

### Changed
- Engine default now `auto` (GraphQL primary; Sweetistics only on fallback when configured).

### Tests
- Add engine resolution tests for auto/default behavior.

### Fixed
- GraphQL read: rotate TweetDetail query IDs with fallback to avoid 404s.

## 0.1.0 — 2025-12-20

### Added
- CLI commands: `tweet`, `reply`, `read`, `replies`, `thread`, `search`, `mentions`, `whoami`, `check`.
- URL/ID shorthand for `read`, plus `--json` output where supported.
- GraphQL engine with cookie auth from Firefox/Chrome/env/flags (macOS browsers).
- Sweetistics engine (API key) with automatic fallback when configured.
- Media uploads via Sweetistics with per-item alt text (images or single video).
- Long-form Notes and Articles extraction for full text output.
- Thread + reply fetching with full conversation parsing.
- Search + mentions via GraphQL (latest timeline).
- JSON5 config files (`~/.config/bird/config.json5`, `./.birdrc.json5`) with engine defaults, profiles, allowChrome/allowFirefox, and timeoutMs.
- Request timeouts (`--timeout`, `timeoutMs`) for GraphQL and Sweetistics calls.
- Bun-compiled standalone binary via `pnpm run build`.
- Query ID refresh helper: `pnpm run graphql:update`.
