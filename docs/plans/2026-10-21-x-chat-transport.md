# X Chat Transport and CLI — Design and Implementation Notes

Date: 2026-10-21. This completes the X Chat handover
(`reports/xchat-integration/HANDOVER.html`): the crypto layer was built and
committed (b0ff4cb) without its network half. This adds the transport and the
`birdgang chat` commands that wire it together.

## Route decision

The handover left the transport route open: X's official `/2/chat` REST API
with an OAuth app, or the web GraphQL chat ops. BirdGang builds on the web
GraphQL route:

- It is fully documented and VERIFIED-LIVE in `transport.md`, and it uses the
  same cookie session, bearer, and headers as every other BirdGang command
  (reads and writes alike); `client.getHeaders()` works unchanged.
- The official route needs an OAuth2 user token with `dm.read`/`dm.write`
  scopes, which BirdGang has no machinery for and which requires a developer
  app that must be provisioned out of band.
- The crypto layer is route-agnostic by design, so an official-API transport
  can be swapped in later without touching the CLI.

## Pieces

- `dist/lib/xchat/transport.js` — `createXChatTransport({ client })`: moves
  bytes only, never imports the crypto layer. Own key record + juicebox tokens
  (GetPublicKeysQuery), paged inbox (GetInitialXChatPageQuery /
  GetInboxPageRequestQuery), a conversation's events
  (GetConversationPageQuery, backwards, `has_more`/empty-page stops), writes
  (SendMessageCreateMutation, AddEncryptedConversationKeysMutation) and
  encrypted media (initialize → ton.x.com segments → finalize; download with a
  colon→hyphen 404 fallback).
- `dist/lib/xchat/ops.json` — the 16 op ids X's web chat client ships today,
  plus a runtime cache (`~/.config/bird/xchat-ops.json`, TTL 24 h) re-synced
  from X's public embed manifest (`chat.x.com/embed-v1.json` → dm-core bundle
  regex extraction, both tested offline). HTTP 404 or `PersistedQueryNotFound`
  triggers one re-sync + retry, mirroring BirdGang's query-id self-healing;
  HTTP 403 / error code 353 picks the fresh `ct0` from `set-cookie` and retries
  once.
- `dist/commands/chat.js` — `birdgang chat` subcommands: `unlock --remember`,
  `forget`, `inbox`, `read`, `send` (`--media`, `--ttl <seconds>`,
  `--no-notify`), `reply`, `react [--remove]`, `edit`, `dl`, all with `--json`.
  `send`/`reply` accept `@handle` for first contact: `prepareFirstContact` →
  `AddEncryptedConversationKeysMutation` → `prepareSend` under the fresh key.
- `tests/xchat-transport-tests.mjs` — 24 offline tests over sample-shaped
  fixtures and a fake fetch (no network, no crypto).

## Open questions from the handover, resolved

- **Media message-id linkage (handover §6.1).** Resolved against X's own
  chat-xdk v0.5.2 example clients: the official `/2/chat/media/upload`
  `initialize` takes only `conversation_id` and `total_bytes` — no message id
  at all. The web mutation's `message_id` is a client-minted session UUID, so
  the transport mints one (`randomUUID()`) and the sent message's SDK-minted id
  is independent. Not live-verified against the web GraphQL variant; listed
  below.
- **Conversation token (SendMessageCreateMutation).** Optional and not exposed
  by the Thrift reader; omitted. Sends work without it per the transport.md
  recipe.
- **Send id form.** The web mutation takes the colon form (`100:200`), unlike
  the official REST URL paths, which take the hyphen form.
  `toSendCreateVariables` canonicalizes.

## Still to verify against one live conversation (writes were never exercised)

1. `chat unlock --remember`, then a second run with no PIN.
2. `chat send` to a self-DM, then `chat read` of the same conversation.
3. One image send (`--media`) and `chat dl` of its media hash key: the ton
   segment `partNumber` base (assumed 1-based) and the colon/hyphen download
   path.
4. Entity offsets with an emoji before a link (handover §6.2), and one
   per-message-key (`contents_encryption_version 1`) message.
5. `x-client-transaction-id` enforcement on mutations (random hex accepted for
   every query tested; mutations untested).

## Safety carried from the handover

- No browser at runtime; headless hosts pass `CHAT_PIN`/`BIRDGANG_CHAT_PIN`.
- Juicebox tokens are fetched immediately before each unlock; the PIN is
  never retried automatically (20-guess limit, then the key locks).
- No secrets in logs; decrypted media is written 0600 in a 0700 dir.
- `GetPublicKeysQuery` is rate-limited (50/window): the inbox asks for
  participants' keys inline (`include_user_public_keys`) and unverified senders
  are fetched in one batch only when they appear.
