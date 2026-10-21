// ABOUTME: X Chat network transport over the web GraphQL chat ops — it only moves bytes, never crypto.
// ABOUTME: Op ids come from ops.json and re-sync from X's public embed manifest when they go stale.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { ident, readBase64Struct } from './thrift.js';

const GRAPHQL_BASE = 'https://x.com/i/api/graphql';
const TON_MEDIA_BASE = 'https://ton.x.com/i/ton/data/xchat_media';
const EMBED_MANIFEST_URL = 'https://chat.x.com/embed-v1.json';
const OPS_CACHE_FILENAME = 'xchat-ops.json';
const OPS_TTL_MS = 24 * 60 * 60 * 1000;
// Encrypted media segments POST to ton.x.com (dm-core tiers go up to 7.5 MB; 4 MiB matches media.js parts).
const UPLOAD_SEGMENT_BYTES = 4 * 1024 * 1024;
const UPLOAD_RETRIES = 3;
const ROOT_FIELDS = {
    GetInitialXChatPageQuery: 'get_initial_chat_page',
    GetInboxPageRequestQuery: 'get_inbox_page',
    GetConversationPageQuery: 'get_conversation_page',
    GetMessageEventsPageQuery: 'get_message_events_page',
    GetPublicKeysQuery: 'user_results_by_rest_ids',
    SendMessageCreateMutation: 'xchat_send_create_message_event',
    AddEncryptedConversationKeysMutation: 'xchat_add_encrypted_conversation_key',
    InitializeXChatMediaUploadMutation: 'xchat_initialize_media_upload',
    FinalizeXChatMediaUploadMutation: 'xchat_finalize_media_upload',
};
/** The ops X's web chat client ships today (name → id), refreshed from the embed manifest when stale. */
export const BUNDLED_XCHAT_OPS = JSON.parse(readFileSync(new URL('./ops.json', import.meta.url), 'utf8')).operations;

// ---- op ids ---------------------------------------------------------------------------------------------
export function xchatOpsCachePath() {
    const override = process.env.BIRDGANG_XCHAT_OPS_CACHE;
    return override && override.trim() ? path.resolve(override.trim()) : path.join(homedir(), '.config', 'bird', OPS_CACHE_FILENAME);
}
function readOpsCache() {
    try {
        const snapshot = JSON.parse(readFileSync(xchatOpsCachePath(), 'utf8'));
        return snapshot?.operations && typeof snapshot.operations === 'object' && snapshot.fetchedAt
            ? snapshot
            : null;
    }
    catch {
        return null;
    }
}
function writeOpsCache(snapshot) {
    const file = xchatOpsCachePath();
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, file);
}
/** Fresh runtime ops (within the TTL) merged over the bundled ones, or just the bundled ones. */
export function resolveXChatOps() {
    const snapshot = readOpsCache();
    if (snapshot && Date.now() - new Date(snapshot.fetchedAt).getTime() <= OPS_TTL_MS) {
        return { ...BUNDLED_XCHAT_OPS, ...snapshot.operations };
    }
    return { ...BUNDLED_XCHAT_OPS };
}
export function resolveXChatOpId(name, ops = resolveXChatOps()) {
    const id = ops[name];
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(id)) {
        throw new Error(`Unknown X Chat operation "${name}"; re-sync ops with refreshXChatOps()`);
    }
    return id;
}
/** The dm-core entry of an embed manifest (`metaData.publicPath` is its base URL). */
export function pickDmCoreEntry(manifest) {
    const entries = [];
    for (const expose of Object.values(manifest?.exposes ?? {})) {
        const js = expose?.assets?.js ?? {};
        entries.push(...(Array.isArray(js.sync) ? js.sync : []), ...(Array.isArray(js.async) ? js.async : []));
    }
    return entries.find((entry) => /(^|\/)dm-core-[\w-]+\.js$/.test(entry)) ?? null;
}
/**
 * Extract name → id from a dm-core bundle. Apollo Kotlin emits each operation's id next to its
 * document string; the `(query|mutation) Name` document check removes false positives.
 */
export function extractEmbedOps(src) {
    const ops = {};
    const doc = {};
    for (const [, kind, name] of src.matchAll(/`(query|mutation|subscription) ([A-Za-z][A-Za-z0-9_]*)[ (]/g)) {
        doc[name] = kind;
    }
    for (const [, id, name] of src.matchAll(/`([A-Za-z0-9_-]{22})`,this\.[\w$]+=`([A-Za-z][A-Za-z0-9_]*)`/g)) {
        if (doc[name]) {
            ops[name] = id;
        }
    }
    return ops;
}
/**
 * Re-sync chat op ids from X's public embed manifest. Merges over the bundled ops so ops that
 * disappear from the bundle keep working. Writes the runtime cache and returns the merged ids.
 */
export async function refreshXChatOps({ fetchImpl = fetch, force = false } = {}) {
    const snapshot = readOpsCache();
    if (!force && snapshot && Date.now() - new Date(snapshot.fetchedAt).getTime() <= OPS_TTL_MS) {
        return { ...BUNDLED_XCHAT_OPS, ...snapshot.operations };
    }
    const manifestResponse = await fetchImpl(EMBED_MANIFEST_URL, { headers: { accept: 'application/json' } });
    if (!manifestResponse.ok) {
        throw new Error(`Could not fetch the X Chat embed manifest (HTTP ${manifestResponse.status})`);
    }
    const manifest = await manifestResponse.json();
    const entry = pickDmCoreEntry(manifest);
    const publicPath = manifest?.metaData?.publicPath;
    if (!entry || !publicPath) {
        throw new Error('The X Chat embed manifest has no dm-core entry');
    }
    const coreResponse = await fetchImpl(`${publicPath}${entry}`);
    if (!coreResponse.ok) {
        throw new Error(`Could not fetch the X Chat client bundle (HTTP ${coreResponse.status})`);
    }
    const discovered = extractEmbedOps(await coreResponse.text());
    if (Object.keys(discovered).length === 0) {
        throw new Error('No X Chat operations found in the client bundle');
    }
    writeOpsCache({
        fetchedAt: new Date().toISOString(),
        embedBuild: manifest?.metaData?.buildId ?? null,
        source: entry,
        operations: discovered,
    });
    return { ...BUNDLED_XCHAT_OPS, ...discovered };
}

// ---- pure request/response mapping ----------------------------------------------------------------------
const isDigits = (value) => /^\d+$/.test(value);
const numericFirst = (a, b) => (a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0);
// Mirror of decode.js's conversationIdForms, kept local so the transport never imports the crypto layer.
function conversationIdForms(conversationId) {
    const id = String(conversationId ?? '').trim();
    const pair = id.replace(/^@/, '').split(/[:-]/);
    if (pair.length === 2 && pair.every(isDigits)) {
        const [a, b] = pair.sort(numericFirst);
        return { colon: `${a}:${b}`, hyphen: `${a}-${b}`, participants: [a, b] };
    }
    return { colon: id, hyphen: id, participants: [] };
}
/** SendMessageCreateMutation variables from a chat-xdk SendPayload. */
export function toSendCreateVariables({ conversationId, payload, conversationToken }) {
    const ids = conversationIdForms(conversationId);
    return {
        conversation_id: ids.colon,
        message_id: payload.messageId,
        ...(conversationToken ? { conversation_token: conversationToken } : {}),
        encoded_message_create_event: payload.encryptedContent,
        encoded_message_event_signature: payload.encodedEventSignature,
    };
}
/**
 * AddEncryptedConversationKeysMutation variables from a prepared conversation-key change
 * (`prepareConversationKeyChange` / `prepareFirstContact` output), in X's own example's mapping.
 * `signingPublicKey` is the sender's signing public key (`engine.getPublicKeys()`).
 */
export function toFirstContactVariables({ conversationId, change, signingPublicKey, ttlMsec }) {
    const ids = conversationIdForms(conversationId);
    return {
        conversation_id: ids.colon,
        conversation_key_version: String(change.conversationKeyVersion),
        conversation_participant_keys: (change.participantKeys ?? []).map((participant) => ({
            user_id: String(participant.userId),
            encrypted_conversation_key: participant.encryptedKey,
            public_key_version: String(participant.publicKeyVersion),
        })),
        ...(change.actionSignatures?.length
            ? {
                action_signatures: change.actionSignatures.map((sig) => ({
                    message_id: sig.messageId,
                    encoded_message_event_detail: sig.encodedMessageEventDetail,
                    ...(sig.signaturePayload ? { signature_payload: sig.signaturePayload } : {}),
                    message_event_signature: {
                        signature: sig.signature,
                        signature_version: sig.signatureVersion,
                        public_key_version: sig.publicKeyVersion,
                        ...(signingPublicKey ? { signing_public_key: signingPublicKey } : {}),
                    },
                })),
            }
            : {}),
        ...(ttlMsec ? { ttl_msec: String(ttlMsec) } : {}),
    };
}
export function toMediaInitVariables({ conversationId, messageId, totalBytes, contentType }) {
    return {
        conversation_id: conversationIdForms(conversationId).colon,
        message_id: messageId,
        total_bytes: String(totalBytes),
        ...(contentType ? { content_type: contentType } : {}),
    };
}
export function toMediaFinalizeVariables({ conversationId, messageId, mediaHashKey, resumeId, numParts }) {
    return {
        conversation_id: conversationIdForms(conversationId).colon,
        message_id: messageId,
        media_hash_key: mediaHashKey,
        resume_id: String(resumeId),
        num_parts: String(numParts),
    };
}
/** The key entries of one `get_public_keys` value: latest version first, API-shaped for normalizeSigningKeys. */
function keyEntriesFrom(getPublicKeys, includeJuiceboxTokens) {
    if (!Array.isArray(getPublicKeys?.public_keys_with_token_map)) {
        return [];
    }
    return getPublicKeys.public_keys_with_token_map
        .map((entry) => {
        const metadata = entry?.public_key_with_metadata ?? {};
        const publicKey = metadata.public_key ?? {};
        return {
            user_id: String(metadata.userId ?? ''),
            public_key_version: String(metadata.version ?? ''),
            public_key: publicKey.public_key,
            signing_public_key: publicKey.signing_public_key,
            identity_public_key_signature: publicKey.identity_public_key_signature,
            ...(includeJuiceboxTokens && entry?.token_map ? { juicebox_config: entry.token_map } : {}),
        };
    })
        .filter((entry) => entry.public_key && entry.signing_public_key)
        .sort((a, b) => numericFirst(b.public_key_version, a.public_key_version));
}
/** A user's public-key record, newest key version first, shaped for `normalizeSigningKeys` and `unlock()`. */
function keyRecordFrom(userId, userResult, includeJuiceboxTokens) {
    const permissions = userResult?.chat_permissions ?? {};
    const keys = userResult?.get_public_keys;
    if (keys?.__typename === 'GetPublicKeysError') {
        return { userId, unavailable: true, reason: keys?.error ?? 'no public keys' };
    }
    const entries = keyEntriesFrom(keys, includeJuiceboxTokens).map((entry) => ({ ...entry, user_id: userId }));
    if (entries.length === 0) {
        return { userId, unavailable: true, reason: 'no usable public keys' };
    }
    return {
        userId,
        registrationMethod: keys.registration_method ?? null,
        isManagedPinUser: Boolean(keys.is_managed_pin_user),
        canDm: permissions.can_dm !== false,
        hasPublicKey: permissions.has_public_key !== false,
        keys: entries,
        latest: entries[0],
    };
}
/** GetPublicKeysQuery response → one record per requested user (unavailable users carry `unavailable`). */
export function parseKeyRecords(response, requestedIds = []) {
    const results = response?.data?.user_results_by_rest_ids ?? response?.user_results_by_rest_ids ?? [];
    const byId = new Map();
    for (const item of results) {
        const userId = String(item?.rest_id ?? '');
        if (!userId || item?.result?.__typename === 'UserUnavailable') {
            continue;
        }
        byId.set(userId, keyRecordFrom(userId, item.result, true));
    }
    return requestedIds.map((id) => byId.get(String(id)) ?? { userId: String(id), unavailable: true, reason: 'not returned' });
}
function userFromResults(result) {
    const user = result?.result ?? {};
    return {
        id: String(result?.rest_id ?? user.rest_id ?? ''),
        name: user?.core?.name ?? null,
        screenName: user?.core?.screen_name ?? null,
        hasPublicKey: user?.chat_permissions?.has_public_key === true,
        canDm: user?.chat_permissions?.can_dm !== false,
        isTrusted: user?.chat_permissions?.is_trusted === true,
        // Present when the inbox query asked for include_user_public_keys.
        keys: keyEntriesFrom(user?.get_public_keys, false),
    };
}
function participantsFrom(detail) {
    if (detail?.__typename === 'XChatGroupConversationDetail') {
        const members = [...(detail.group_members_results ?? []), ...(detail.group_admins_results ?? [])];
        const seen = new Set();
        return members.filter((member) => {
            const id = String(member?.rest_id ?? '');
            if (!id || seen.has(id)) {
                return false;
            }
            seen.add(id);
            return true;
        }).map(userFromResults);
    }
    return (detail?.participants_results ?? []).map(userFromResults).filter((participant) => participant.id);
}
/** One inbox page (GetInitialXChatPageQuery / GetInboxPageRequestQuery) → conversations + cursor. */
export function parseInboxPage(page) {
    const conversations = (page?.items ?? []).map((item) => {
        const detail = item?.conversation_detail ?? {};
        return {
            conversationId: detail.conversation_id ?? null,
            isGroup: detail.__typename === 'XChatGroupConversationDetail',
            isArchived: detail.is_archived === true,
            isMuted: detail.is_muted === true,
            messageTtlMsec: detail.message_ttl_msec ?? null,
            participants: participantsFrom(detail),
            events: item?.latest_message_events ?? [],
            keyChangeEvents: item?.latest_conversation_key_change_events ?? [],
        };
    }).filter((conversation) => conversation.conversationId);
    const cursor = page?.inboxCursor ?? page?.cursor ?? null;
    const next = cursor?.__typename === 'XChatGetInboxPageContinueCursor'
        ? { kind: 'continue', cursorId: cursor.cursor_id, graphSnapshotId: cursor.graph_snapshot_id }
        : { kind: 'end', inboxExhausted: cursor?.inbox_exhausted ?? null, graphSnapshotId: cursor?.graph_snapshot_id ?? null };
    return {
        conversations,
        next,
        maxUserSequenceId: page?.max_user_sequence_id ?? null,
        messageRequestsCount: page?.message_requests_count ?? null,
    };
}
/** One GetConversationPageQuery page: events (newest first), missing key changes, and the page's oldest sequence id. */
export function parseConversationPage(page) {
    const events = page?.encoded_message_events ?? [];
    const keyChangeEvents = page?.missing_conversation_key_change_events ?? [];
    let minSequenceId = null;
    for (const b64 of events) {
        try {
            const sequenceId = ident(readBase64Struct(b64)[1]);
            if (sequenceId && (minSequenceId === null || numericFirst(sequenceId, minSequenceId) < 0)) {
                minSequenceId = sequenceId;
            }
        }
        catch {
            // A malformed event is decode.js's problem to report, not the transport's.
        }
    }
    return {
        events,
        keyChangeEvents,
        hasMore: page?.has_more === true && events.length > 0,
        minSequenceId,
    };
}

// ---- transport ------------------------------------------------------------------------------------------
/** A chat GraphQL failure with its server error code (X returns most failures as HTTP 200 + `errors[]`). */
export class XChatTransportError extends Error {
    code;
    status;
    constructor(message, { code, status } = {}) {
        super(code === undefined || code === null ? message : `${message} (code ${code})`);
        this.name = 'XChatTransportError';
        this.code = code ?? null;
        this.status = status ?? null;
    }
}
function firstGraphqlError(errors) {
    const error = Array.isArray(errors) ? errors[0] : errors;
    const code = error?.extensions?.code ?? error?.code ?? error?.extensions?.kind ?? null;
    const message = error?.message ?? error?.name ?? 'GraphQL request failed';
    return { code: code === undefined ? null : code, message };
}
function ct0FromCookies(response) {
    const cookies = response.headers?.getSetCookie?.() ?? [];
    for (const cookie of cookies) {
        const match = /(?:^|;\s*)ct0=([^;]+)/.exec(cookie);
        if (match) {
            return match[1];
        }
    }
    return null;
}
/**
 * The X Chat transport. `client` is a BirdGang TwitterClient (its headers, cookies and timeouts are
 * reused as-is); `fetchImpl` is injectable for tests. It only moves bytes: every request and
 * response shape below is documented in reports/xchat-integration/transport.md or mirrors X's
 * own chat-xdk example clients.
 */
export function createXChatTransport({ client, fetchImpl, ops = resolveXChatOps() } = {}) {
    const http = fetchImpl ?? ((url, init) => client.fetchWithTimeout(url, init));
    let currentOps = { ...ops };
    let currentCt0 = client.ct0;
    let currentCookieHeader = client.cookieHeader;
    const headersFor = (kind) => {
        const headers = kind === 'mutation' ? client.getJsonHeaders() : kind === 'media' ? client.getBaseHeaders() : client.getHeaders();
        if (currentCt0 !== client.ct0 || currentCookieHeader !== client.cookieHeader) {
            headers['x-csrf-token'] = currentCt0;
            headers.cookie = currentCookieHeader;
        }
        return headers;
    };
    const opUrl = (name) => `${GRAPHQL_BASE}/${resolveXChatOpId(name, currentOps)}/${name}`;
    async function requestOnce(name, { variables, mutation }) {
        const url = opUrl(name);
        const init = mutation
            ? { method: 'POST', headers: headersFor('mutation'), body: JSON.stringify({ variables }) }
            : { method: 'GET', headers: headersFor('query') };
        const target = mutation ? url : `${url}?${new URLSearchParams({ variables: JSON.stringify(variables ?? {}) })}`;
        const response = await http(target, init);
        if (!response.ok) {
            return { response, data: null };
        }
        const text = await response.text();
        let data = null;
        try {
            data = text ? JSON.parse(text) : null;
        }
        catch {
            data = null;
        }
        return { response, data };
    }
    // One GraphQL op, with the two self-heals X needs: a stale op id (HTTP 404 or
    // PersistedQueryNotFound) re-syncs ops from the embed manifest, and a CSRF expiry (HTTP 403 or
    // error code 353) picks the fresh ct0 out of set-cookie and retries once.
    async function request(name, { variables, mutation = false }) {
        let refreshedIds = false;
        let refreshedCt0 = false;
        for (let attempt = 0; attempt < 4; attempt++) {
            const { response, data } = await requestOnce(name, { variables, mutation });
            const bodyErrors = data?.errors;
            const error = bodyErrors ? firstGraphqlError(bodyErrors) : null;
            if (response.status === 403 || error?.code === 353) {
                if (refreshedCt0) {
                    throw new XChatTransportError(`X Chat session rejected (${error?.message ?? 'HTTP 403'}); refresh your cookies`, { code: 353, status: response.status });
                }
                const fresh = ct0FromCookies(response);
                if (!fresh) {
                    throw new XChatTransportError('X Chat session rejected (HTTP 403) and no fresh ct0 cookie was served; refresh your cookies', { status: response.status });
                }
                currentCt0 = fresh;
                currentCookieHeader = currentCookieHeader.includes('ct0=')
                    ? currentCookieHeader.replace(/ct0=[^;]*/, `ct0=${fresh}`)
                    : `${currentCookieHeader}; ct0=${fresh}`;
                refreshedCt0 = true;
                continue;
            }
            if (response.status === 404 || error?.code === 'PersistedQueryNotFound') {
                if (refreshedIds) {
                    throw new XChatTransportError(`X Chat operation ${name} was rejected even after re-syncing op ids`, { status: response.status });
                }
                currentOps = await refreshXChatOps({ fetchImpl: http });
                refreshedIds = true;
                continue;
            }
            if (bodyErrors?.length) {
                throw new XChatTransportError(`X Chat ${name} failed: ${error.message}`, { code: error.code, status: response.status });
            }
            if (!response.ok) {
                const body = await response.text().catch(() => '');
                throw new XChatTransportError(`X Chat ${name} failed (HTTP ${response.status})${body ? `: ${body.slice(0, 200)}` : ''}`, { status: response.status });
            }
            return data;
        }
        throw new XChatTransportError(`X Chat ${name} failed after retries`);
    }
    async function graphql(name, { variables, mutation = false }) {
        const data = await request(name, { variables, mutation });
        const root = data?.data?.[ROOT_FIELDS[name]];
        if (root === undefined || root === null) {
            throw new XChatTransportError(`X Chat ${name} returned no "${ROOT_FIELDS[name]}" field`);
        }
        return root;
    }
    // ---- reads: keys, inbox, events -------------------------------------------------------------------------
    /** Public-key records for a batch of user ids, newest key version first inside each record. */
    async function getPublicKeys(userIds, { includeJuiceboxTokens = false } = {}) {
        const ids = [...new Set(userIds.map((id) => String(id)).filter(isDigits))];
        if (ids.length === 0) {
            return [];
        }
        const records = [];
        for (let at = 0; at < ids.length; at += 50) {
            const chunk = ids.slice(at, at + 50);
            const response = await graphql('GetPublicKeysQuery', {
                variables: { ids: chunk, ...(includeJuiceboxTokens ? { include_juicebox_tokens: true } : {}) },
            });
            for (const record of parseKeyRecords({ data: { user_results_by_rest_ids: response } }, chunk)) {
                // The query only returns token maps when asked; drop any the response did not hold.
                if (!includeJuiceboxTokens) {
                    for (const key of record.keys ?? []) {
                        delete key.juicebox_config;
                    }
                }
                records.push(record);
            }
        }
        return records;
    }
    /** The signed-in user's own key record (fresh Juicebox tokens included, for unlock). */
    async function getOwnKeyRecord({ userId, includeJuiceboxTokens = true } = {}) {
        const [record] = await getPublicKeys([userId], { includeJuiceboxTokens });
        return record ?? { userId: String(userId), unavailable: true, reason: 'not returned' };
    }
    /** The inbox: conversations with their latest events and participants (with public keys inline). */
    async function getInbox({ limit = 30 } = {}) {
        const conversations = [];
        const first = parseInboxPage(await graphql('GetInitialXChatPageQuery', { variables: { include_user_public_keys: true } }));
        let state = first;
        conversations.push(...first.conversations);
        while (state.next.kind === 'continue' && conversations.length < limit) {
            const page = parseInboxPage(await graphql('GetInboxPageRequestQuery', {
                variables: {
                    continue_cursor: { cursor_id: state.next.cursorId, graph_snapshot_id: state.next.graphSnapshotId },
                    include_user_public_keys: true,
                },
            }));
            state = page;
            conversations.push(...page.conversations);
        }
        const unique = [];
        const seen = new Set();
        for (const conversation of conversations) {
            if (!seen.has(conversation.conversationId)) {
                seen.add(conversation.conversationId);
                unique.push(conversation);
            }
        }
        return {
            conversations: unique.slice(0, limit),
            cursor: state.next,
            maxUserSequenceId: first.maxUserSequenceId,
            messageRequestsCount: first.messageRequestsCount,
        };
    }
    /**
     * A conversation's events, backwards from `maxSequenceId` (the inbox's `max_user_sequence_id`).
     * Stops at `has_more: false`, an empty page (X treats "0 events" as exhausted), or `limit` events.
     */
    async function getConversationEvents({ conversationId, maxSequenceId, limit = 100, pageLimit = 50 } = {}) {
        const ids = conversationIdForms(conversationId);
        if (!maxSequenceId) {
            throw new Error('getConversationEvents needs the inbox max_user_sequence_id to page from');
        }
        const events = [];
        const keyChangeEvents = [];
        let minSequenceId = String(maxSequenceId);
        let truncated = false;
        for (;;) {
            const page = parseConversationPage(await graphql('GetConversationPageQuery', {
                variables: {
                    conversation_id: ids.colon,
                    min_local_sequence_id: String(minSequenceId),
                    min_conversation_key_version: '0',
                    query_settings: { conversation_event_limit: pageLimit },
                },
            }));
            events.push(...page.events);
            keyChangeEvents.push(...page.keyChangeEvents);
            if (events.length >= limit) {
                truncated = page.hasMore;
                break;
            }
            if (!page.hasMore || !page.minSequenceId) {
                break;
            }
            minSequenceId = page.minSequenceId;
        }
        return { events, keyChangeEvents, oldestSequenceId: minSequenceId, truncated };
    }
    // ---- writes: messages, keys, media ----------------------------------------------------------------------
    /** POST a SendPayload from prepareSend(); returns the server-sequenced event (base64). */
    async function sendMessageCreate({ conversationId, payload, conversationToken } = {}) {
        const result = await graphql('SendMessageCreateMutation', {
            variables: toSendCreateVariables({ conversationId, payload, conversationToken }),
            mutation: true,
        });
        if (result.error_code !== undefined && result.error_code !== null) {
            throw new XChatTransportError(`X rejected the message (error_code ${result.error_code})`, { code: result.error_code });
        }
        return { event: result.encoded_message_event ?? null };
    }
    /** POST the first-contact (or rotated) conversation-key change from prepareFirstContact(). */
    async function addConversationKeys({ conversationId, change, signingPublicKey, ttlMsec } = {}) {
        const result = await graphql('AddEncryptedConversationKeysMutation', {
            variables: toFirstContactVariables({ conversationId, change, signingPublicKey, ttlMsec }),
            mutation: true,
        });
        if (result.error_code !== undefined && result.error_code !== null) {
            throw new XChatTransportError(`X rejected the conversation key change (error_code ${result.error_code})`, { code: result.error_code });
        }
        return { sequenceId: result.conversation_key_change_sequence_id ?? null };
    }
    /**
     * Upload encrypted media (initialize, ton segments, finalize) and return its media_hash_key.
     * The upload's `message_id` is a locally minted session UUID: X's own official API initializes
     * uploads without any message id, so it is not linked to the sent message's id.
     */
    async function uploadMedia({ conversationId, bytes, contentType, segmentBytes = UPLOAD_SEGMENT_BYTES, retries = UPLOAD_RETRIES } = {}) {
        const ids = conversationIdForms(conversationId);
        const messageId = randomUUID();
        const initialized = await graphql('InitializeXChatMediaUploadMutation', {
            variables: toMediaInitVariables({ conversationId: ids.colon, messageId, totalBytes: bytes.length, contentType }),
            mutation: true,
        });
        const mediaHashKey = initialized?.media_hash_key;
        const resumeId = initialized?.resume_id;
        if (!mediaHashKey || !resumeId) {
            throw new XChatTransportError('X Chat media upload could not be initialized', { code: initialized?.upload_error ?? null });
        }
        const partCount = Math.max(1, Math.ceil(bytes.length / segmentBytes));
        for (let part = 1; part <= partCount; part++) {
            const segment = bytes.subarray((part - 1) * segmentBytes, part * segmentBytes);
            const url = `${TON_MEDIA_BASE}/${encodeURIComponent(ids.colon)}/${encodeURIComponent(mediaHashKey)}?concurrent=true&resumeId=${encodeURIComponent(String(resumeId))}&partNumber=${part}`;
            let lastError = null;
            for (let tries = 0; tries < retries; tries++) {
                try {
                    const response = await http(url, {
                        method: 'POST',
                        headers: { ...headersFor('media'), 'content-type': 'application/octet-stream' },
                        body: segment,
                    });
                    if (response.ok) {
                        lastError = null;
                        break;
                    }
                    lastError = new XChatTransportError(`Media segment ${part} upload failed (HTTP ${response.status})`, { status: response.status });
                }
                catch (error) {
                    lastError = error;
                }
                if (tries < retries - 1) {
                    await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** tries));
                }
            }
            if (lastError) {
                throw lastError;
            }
        }
        const finalized = await graphql('FinalizeXChatMediaUploadMutation', {
            variables: toMediaFinalizeVariables({ conversationId: ids.colon, messageId, mediaHashKey, resumeId, numParts: partCount }),
            mutation: true,
        });
        if (finalized?.upload_error !== undefined && finalized?.upload_error !== null) {
            throw new XChatTransportError(`X Chat media upload failed to finalize (${finalized.upload_error})`, { code: finalized.upload_error });
        }
        return { mediaHashKey, resumeId, numParts: partCount, messageId };
    }
    /** Download an attachment's ciphertext from ton.x.com (colon id first, hyphen form on 404). */
    async function downloadMedia({ conversationId, mediaHashKey } = {}) {
        const ids = conversationIdForms(conversationId);
        for (const form of [ids.colon, ids.hyphen]) {
            const url = `${TON_MEDIA_BASE}/${encodeURIComponent(form)}/${encodeURIComponent(String(mediaHashKey))}`;
            const response = await http(url, { method: 'GET', headers: headersFor('media') });
            if (response.ok) {
                return new Uint8Array(await response.arrayBuffer());
            }
            if (response.status === 401) {
                throw new XChatTransportError('ton.x.com rejected the session cookies; refresh your cookies', { status: 401 });
            }
            if (response.status !== 404) {
                const body = await response.text().catch(() => '');
                throw new XChatTransportError(`Media download failed (HTTP ${response.status})${body ? `: ${body.slice(0, 200)}` : ''}`, { status: response.status });
            }
        }
        throw new XChatTransportError(`Media ${mediaHashKey} was not found in this conversation`, { status: 404 });
    }
    return {
        getPublicKeys,
        getOwnKeyRecord,
        getInbox,
        getConversationEvents,
        sendMessageCreate,
        addConversationKeys,
        uploadMedia,
        downloadMedia,
    };
}
