// Offline X Chat transport tests: sample-shaped fixtures and a fake fetch, no network, no crypto.
// Run: node tests/xchat-transport-tests.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Command } from 'commander';

import { TwitterClientBase } from '../dist/lib/twitter-client-base.js';
import { registerChatCommands } from '../dist/commands/chat.js';
import {
    BUNDLED_XCHAT_OPS, XChatTransportError, createXChatTransport, extractEmbedOps, parseConversationPage,
    parseInboxPage, parseKeyRecords, pickDmCoreEntry, refreshXChatOps, resolveXChatOpId, resolveXChatOps,
    toFirstContactVariables, toMediaFinalizeVariables, toMediaInitVariables, toSendCreateVariables,
} from '../dist/lib/xchat/transport.js';

let passed = 0;
let failed = 0;
async function test(name, fn) {
    try {
        await fn();
        passed += 1;
        console.log(`  ok   ${name}`);
    }
    catch (e) {
        failed += 1;
        console.log(`  FAIL ${name}\n       ${e.message}`);
    }
}

// ---- fixtures and helpers -------------------------------------------------------------------------------
// Minimal Thrift binary writer (same idea as tests/xchat-tests.mjs, for envelope-only events).
const T = { STRING: 11, STRUCT: 12 };
function struct(fields) {
    const parts = [];
    for (const [id, type, value] of fields) {
        if (value !== undefined) {
            parts.push(Uint8Array.of(type, (id >> 8) & 0xff, id & 0xff), value);
        }
    }
    parts.push(Uint8Array.of(0));
    return Buffer.concat(parts);
}
const stringWithLen = (text) => {
    const bytes = Buffer.from(text);
    const len = Buffer.alloc(4);
    len.writeInt32BE(bytes.length);
    return Buffer.concat([len, bytes]);
};
const eventB64 = (sequenceId) => Buffer.from(struct([[1, T.STRING, stringWithLen(String(sequenceId))]])).toString('base64');

const response = ({ status = 200, body, setCookie } = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { getSetCookie: () => (setCookie ? [setCookie] : []) },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    arrayBuffer: async () => body,
});
const client = new TwitterClientBase({ cookies: { authToken: 'auth', ct0: 'csrf-1' } });
const lastVariables = (call) => {
    if (call.init?.method === 'POST') {
        return JSON.parse(call.init.body).variables;
    }
    return JSON.parse(new URL(call.url, 'https://x.com').searchParams.get('variables'));
};

const keyEntry = (version, suffix = '') => ({
    public_key_with_metadata: { version, public_key: { public_key: `pk-${version}${suffix}`, signing_public_key: `sk-${version}${suffix}`, identity_public_key_signature: `sig-${version}${suffix}` } },
    ...(suffix === '' ? { token_map: { token_map: [{ key: 'aa', value: { address: 'r', token: 't' } }] } } : {}),
});
const publicKeysResponse = (ids) => ({
    data: {
        user_results_by_rest_ids: ids.map((id) => ({
            rest_id: id,
            result: {
                __typename: 'User',
                chat_permissions: { can_dm: true, has_public_key: true },
                get_public_keys: {
                    __typename: 'GetPublicKeysResult',
                    registration_method: 'CustomPin',
                    is_managed_pin_user: false,
                    public_keys_with_token_map: id === 'missing' ? [] : [keyEntry('1760000000001'), keyEntry('1760000000002')],
                },
            },
        })),
    },
});
const directConversation = (conversationId, events = ['e1']) => ({
    conversation_detail: {
        __typename: 'XChatDirectConversationDetail',
        conversation_id: conversationId,
        is_archived: false,
        is_muted: true,
        message_ttl_msec: 0,
        participants_results: [
            { rest_id: '100', result: { core: { name: 'One', screen_name: 'one' }, chat_permissions: { has_public_key: true } } },
            { rest_id: '200', result: { core: { name: 'Two', screen_name: 'two' }, chat_permissions: { has_public_key: false } } },
        ],
    },
    latest_message_events: events,
    latest_conversation_key_change_events: ['k1'],
});
const inboxPage = (items, cursor) => ({
    inboxCursor: cursor ?? { __typename: 'XChatGetInboxPageEndCursor', inbox_exhausted: true },
    items,
    max_user_sequence_id: '5000',
    message_requests_count: 0,
});

// ---- ops -----------------------------------------------------------------------------------------------
await test('bundled ops resolve every operation the transport uses, and unknown ops throw', () => {
    const ops = resolveXChatOps();
    for (const name of ['GetInitialXChatPageQuery', 'GetInboxPageRequestQuery', 'GetConversationPageQuery', 'GetPublicKeysQuery', 'SendMessageCreateMutation', 'AddEncryptedConversationKeysMutation', 'InitializeXChatMediaUploadMutation', 'FinalizeXChatMediaUploadMutation']) {
        assert.match(resolveXChatOpId(name, ops), /^[A-Za-z0-9_-]{22}$/);
    }
    assert.throws(() => resolveXChatOpId('NoSuchOp', ops), /Unknown X Chat operation/);
});
await test('a fresh runtime ops cache overrides the bundled ids; a stale one does not', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'xchat-ops-'));
    const cache = path.join(dir, 'ops.json');
    process.env.BIRDGANG_XCHAT_OPS_CACHE = cache;
    try {
        writeFileSync(cache, JSON.stringify({ fetchedAt: new Date().toISOString(), operations: { GetPublicKeysQuery: 'zzzzzzzzzzzzzzzzzzzzzz' } }));
        assert.equal(resolveXChatOpId('GetPublicKeysQuery'), 'zzzzzzzzzzzzzzzzzzzzzz');
        assert.equal(resolveXChatOpId('SendMessageCreateMutation'), BUNDLED_XCHAT_OPS.SendMessageCreateMutation);
        writeFileSync(cache, JSON.stringify({ fetchedAt: '2020-01-01T00:00:00.000Z', operations: { GetPublicKeysQuery: 'zzzzzzzzzzzzzzzzzzzzzz' } }));
        assert.equal(resolveXChatOpId('GetPublicKeysQuery'), BUNDLED_XCHAT_OPS.GetPublicKeysQuery);
    }
    finally {
        delete process.env.BIRDGANG_XCHAT_OPS_CACHE;
        rmSync(dir, { recursive: true, force: true });
    }
});
await test('extractEmbedOps reads Apollo Kotlin op ids and filters false positives', () => {
    const src = [
        'const a=`TWRPP7gnKwV_R8-tE-Dd3Q`,this.b=`SendMessageCreateMutation`;',
        '`mutation SendMessageCreateMutation { x }`',
        'const c=`C-YphxeIcPLOGtFNGhkuOw`,this.d=`GetPublicKeysQuery`;',
        '`query GetPublicKeysQuery { y }`',
        'const e=`NOTANOPIDSHORT`,this.f=`GetInboxPageRequestQuery`;',
        'const g=`aaaaaaaaaaaaaaaaaaaaaa`,this.h=`NoDocumentOp`;',
    ].join('\n');
    const ops = extractEmbedOps(src);
    assert.equal(ops.SendMessageCreateMutation, 'TWRPP7gnKwV_R8-tE-Dd3Q');
    assert.equal(ops.GetPublicKeysQuery, 'C-YphxeIcPLOGtFNGhkuOw');
    assert.equal(ops.GetInboxPageRequestQuery, undefined); // no (query … document for it
    assert.equal(ops.NoDocumentOp, undefined);
});
await test('pickDmCoreEntry finds the dm-core asset in an embed manifest', () => {
    const manifest = {
        metaData: { publicPath: 'https://abs.twimg.com/x-web/xchat/embed/abc/' },
        exposes: {
            './xchat-init': { assets: { js: { sync: ['assets/init-XYZ.js'], async: [] } } },
            './dm-core': { assets: { js: { sync: ['assets/other.js'], async: ['assets/dm-core-CLOyoNIK.js'] } } },
        },
    };
    assert.equal(pickDmCoreEntry(manifest), 'assets/dm-core-CLOyoNIK.js');
    assert.equal(pickDmCoreEntry({ exposes: {} }), null);
});
await test('refreshXChatOps fetches the manifest and dm-core bundle, and writes the cache', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'xchat-refresh-'));
    process.env.BIRDGANG_XCHAT_OPS_CACHE = path.join(dir, 'ops.json');
    const refreshedId = 'a'.repeat(21) + '1';
    try {
        const bundle = `\`${refreshedId}\`,this.x=\`RefreshedQuery\`\n\`query RefreshedQuery { z }\``;
        const fetchImpl = async (url) => {
            if (url === 'https://chat.x.com/embed-v1.json') {
                return response({ body: JSON.stringify({ metaData: { publicPath: 'https://abs.twimg.com/x/embed/1/' }, exposes: { './dm-core': { assets: { js: { sync: ['assets/dm-core-TEST.js'] } } } } }) });
            }
            if (url === 'https://abs.twimg.com/x/embed/1/assets/dm-core-TEST.js') {
                return response({ body: bundle });
            }
            throw new Error(`unexpected url ${url}`);
        };
        const ops = await refreshXChatOps({ fetchImpl, force: true });
        assert.equal(ops.RefreshedQuery, refreshedId);
        assert.equal(ops.SendMessageCreateMutation, BUNDLED_XCHAT_OPS.SendMessageCreateMutation);
        assert.equal(resolveXChatOpId('RefreshedQuery'), refreshedId);
    }
    finally {
        delete process.env.BIRDGANG_XCHAT_OPS_CACHE;
        rmSync(dir, { recursive: true, force: true });
    }
});

// ---- pure mappers ---------------------------------------------------------------------------------------
await test('toSendCreateVariables maps a SendPayload with the colon conversation id', () => {
    const variables = toSendCreateVariables({
        conversationId: '200-100',
        payload: { messageId: 'm-1', encryptedContent: 'ENC', encodedEventSignature: 'SIG' },
        conversationToken: 'tok',
    });
    assert.deepEqual(variables, {
        conversation_id: '100:200',
        message_id: 'm-1',
        conversation_token: 'tok',
        encoded_message_create_event: 'ENC',
        encoded_message_event_signature: 'SIG',
    });
    const withoutToken = toSendCreateVariables({ conversationId: 'g123', payload: { messageId: 'm-1', encryptedContent: 'ENC', encodedEventSignature: 'SIG' } });
    assert.equal(withoutToken.conversation_token, undefined);
    assert.equal(withoutToken.conversation_id, 'g123');
});
await test('toFirstContactVariables maps participant keys and action signatures to snake_case', () => {
    const change = {
        conversationKeyVersion: '1760000000999',
        participantKeys: [{ userId: '200', encryptedKey: 'EK', publicKeyVersion: '1760000000002' }],
        actionSignatures: [{ messageId: 'm-2', encodedMessageEventDetail: 'DET', signaturePayload: undefined, signature: 'S', signatureVersion: '6', publicKeyVersion: '1760000000002' }],
    };
    const variables = toFirstContactVariables({ conversationId: '100:200', change, signingPublicKey: 'MY-SK', ttlMsec: 60000 });
    assert.equal(variables.conversation_id, '100:200');
    assert.equal(variables.conversation_key_version, '1760000000999');
    assert.deepEqual(variables.conversation_participant_keys, [{ user_id: '200', encrypted_conversation_key: 'EK', public_key_version: '1760000000002' }]);
    assert.deepEqual(variables.action_signatures, [{
        message_id: 'm-2',
        encoded_message_event_detail: 'DET',
        message_event_signature: { signature: 'S', signature_version: '6', public_key_version: '1760000000002', signing_public_key: 'MY-SK' },
    }]);
    assert.equal(variables.ttl_msec, '60000');
    const noSigs = toFirstContactVariables({ conversationId: '100:200', change: { conversationKeyVersion: '1', participantKeys: [] } });
    assert.equal(noSigs.action_signatures, undefined);
    assert.equal(noSigs.ttl_msec, undefined);
});
await test('media init and finalize variables carry the colon id and string counters', () => {
    assert.deepEqual(toMediaInitVariables({ conversationId: '100:200', messageId: 'm-3', totalBytes: 1234, contentType: 'image/png' }), {
        conversation_id: '100:200', message_id: 'm-3', total_bytes: '1234', content_type: 'image/png',
    });
    assert.equal(toMediaInitVariables({ conversationId: '100:200', messageId: 'm-3', totalBytes: 1 }).content_type, undefined);
    assert.deepEqual(toMediaFinalizeVariables({ conversationId: '100:200', messageId: 'm-3', mediaHashKey: 'MHK', resumeId: 7, numParts: 2 }), {
        conversation_id: '100:200', message_id: 'm-3', media_hash_key: 'MHK', resume_id: '7', num_parts: '2',
    });
});

// ---- pure parsers ---------------------------------------------------------------------------------------
await test('parseKeyRecords picks the latest version, keeps the juicebox config, and flags missing users', () => {
    const records = parseKeyRecords(publicKeysResponse(['100', 'missing']), ['100', 'missing', 'absent']);
    assert.equal(records.length, 3);
    const own = records[0];
    assert.equal(own.userId, '100');
    assert.equal(own.registrationMethod, 'CustomPin');
    assert.equal(own.latest.public_key_version, '1760000000002');
    assert.equal(own.latest.public_key, 'pk-1760000000002');
    assert.equal(own.latest.signing_public_key, 'sk-1760000000002');
    assert.ok(own.latest.juicebox_config);
    assert.equal(records[1].unavailable, true);
    assert.equal(records[2].unavailable, true);
    assert.equal(records[2].reason, 'not returned');
});
await test('parseInboxPage reads conversations, participants and both cursor kinds', () => {
    const page = parseInboxPage(inboxPage([directConversation('100:200'), { conversation_detail: { __typename: 'XChatGroupConversationDetail', conversation_id: 'g123', group_members_results: [{ rest_id: '100', result: { core: {} } }], group_admins_results: [{ rest_id: '300', result: { core: {} } }] } }]));
    assert.equal(page.conversations.length, 2);
    const direct = page.conversations[0];
    assert.equal(direct.conversationId, '100:200');
    assert.equal(direct.isGroup, false);
    assert.equal(direct.isMuted, true);
    assert.deepEqual(direct.events, ['e1']);
    assert.deepEqual(direct.keyChangeEvents, ['k1']);
    assert.equal(direct.participants[0].screenName, 'one');
    assert.equal(page.next.kind, 'end');
    assert.equal(page.maxUserSequenceId, '5000');
    const group = page.conversations[1];
    assert.equal(group.isGroup, true);
    assert.equal(group.participants.length, 2);
    const next = parseInboxPage(inboxPage([], { __typename: 'XChatGetInboxPageContinueCursor', cursor_id: 'c1', graph_snapshot_id: 'gs1' }));
    assert.deepEqual(next.next, { kind: 'continue', cursorId: 'c1', graphSnapshotId: 'gs1' });
});
await test('parseConversationPage reports has_more only with events, and finds the oldest sequence id', () => {
    const b64s = ['30', '20', '10'].map(eventB64);
    const page = parseConversationPage({ encoded_message_events: b64s, missing_conversation_key_change_events: ['k'], has_more: true });
    assert.deepEqual(page.events, b64s);
    assert.deepEqual(page.keyChangeEvents, ['k']);
    assert.equal(page.hasMore, true);
    assert.equal(page.minSequenceId, '10');
    const empty = parseConversationPage({ encoded_message_events: [], has_more: true });
    assert.equal(empty.hasMore, false);
    assert.equal(parseConversationPage({ encoded_message_events: b64s, has_more: false }).hasMore, false);
});

// ---- transport over a fake fetch -----------------------------------------------------------------------
await test('queries are GETs with a variables param and no features field', async () => {
    const httpCalls = [];
    const http = async (url, init) => {
        httpCalls.push({ url: String(url), init });
        return response({ body: publicKeysResponse(['100']) });
    };
    const transport = createXChatTransport({ client, fetchImpl: http });
    await transport.getPublicKeys(['100']);
    assert.equal(httpCalls.length, 1);
    const call = httpCalls[0];
    assert.equal(call.init.method, 'GET');
    assert.ok(call.url.startsWith(`https://x.com/i/api/graphql/${BUNDLED_XCHAT_OPS.GetPublicKeysQuery}/GetPublicKeysQuery?`));
    const params = new URL(call.url, 'https://x.com').searchParams;
    assert.deepEqual(JSON.parse(params.get('variables')), { ids: ['100'] });
    assert.equal(params.get('features'), null);
    assert.equal(call.init.headers['x-csrf-token'], 'csrf-1');
});
await test('GraphQL errors surface as XChatTransportError with the server code', async () => {
    const http = async () => response({ body: { errors: [{ code: 214, message: 'range order reversed' }] } });
    const transport = createXChatTransport({ client, fetchImpl: http });
    await assert.rejects(() => transport.getPublicKeys(['100']), (error) => {
        assert.ok(error instanceof XChatTransportError);
        assert.equal(error.code, 214);
        assert.match(error.message, /range order reversed/);
        return true;
    });
});
await test('a stale op id (HTTP 404) re-syncs ops from the embed manifest and retries', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'xchat-stale-'));
    process.env.BIRDGANG_XCHAT_OPS_CACHE = path.join(dir, 'ops.json');
    const urls = [];
    const freshId = 'b'.repeat(21) + '1';
    const dmCore = `\`${freshId}\`,this.q=\`GetPublicKeysQuery\`\n\`query GetPublicKeysQuery { q }\``;
    try {
        const http = async (url) => {
            urls.push(String(url));
            if (String(url).includes(`/graphql/${BUNDLED_XCHAT_OPS.GetPublicKeysQuery}/GetPublicKeysQuery`)) {
                return response({ status: 404, body: 'not found' });
            }
            if (url === 'https://chat.x.com/embed-v1.json') {
                return response({ body: JSON.stringify({ metaData: { publicPath: 'https://abs/e/' }, exposes: { './dm-core': { assets: { js: { sync: ['assets/dm-core-NEW.js'] } } } } }) });
            }
            if (url === 'https://abs/e/assets/dm-core-NEW.js') {
                return response({ body: dmCore });
            }
            if (String(url).includes(`/graphql/${freshId}/GetPublicKeysQuery`)) {
                return response({ body: publicKeysResponse(['100']) });
            }
            throw new Error(`unexpected url ${url}`);
        };
        const transport = createXChatTransport({ client, fetchImpl: http });
        const records = await transport.getPublicKeys(['100']);
        assert.equal(records[0].userId, '100');
        assert.ok(urls.some((url) => url.includes(`/graphql/${freshId}/`)));
        assert.equal(resolveXChatOpId('GetPublicKeysQuery'), freshId);
    }
    finally {
        delete process.env.BIRDGANG_XCHAT_OPS_CACHE;
        rmSync(dir, { recursive: true, force: true });
    }
});
await test('a CSRF expiry (HTTP 403 + set-cookie ct0) is retried with the fresh token', async () => {
    const seen = [];
    let httpCalls = 0;
    const http = async (url, init) => {
        httpCalls += 1;
        seen.push({ url: String(url), headers: init.headers });
        if (httpCalls === 1) {
            return response({ status: 403, body: JSON.stringify({ errors: [{ code: 353, message: 'csrf' }] }), setCookie: 'ct0=fresh-ct0; SameSite=Lax; Path=/' });
        }
        assert.equal(init.headers['x-csrf-token'], 'fresh-ct0');
        assert.match(init.headers.cookie, /ct0=fresh-ct0/);
        return response({ body: publicKeysResponse(['100']) });
    };
    const transport = createXChatTransport({ client, fetchImpl: http });
    const records = await transport.getPublicKeys(['100']);
    assert.equal(records[0].userId, '100');
    assert.equal(httpCalls, 2);
});
await test('getInbox pages the inbox and stops on the end cursor', async () => {
    const httpCalls = [];
    const http = async (url, init) => {
        httpCalls.push({ url: String(url), init });
        if (String(url).includes('/GetInitialXChatPageQuery')) {
            return response({ body: { data: { get_initial_chat_page: inboxPage([directConversation('100:200')], { __typename: 'XChatGetInboxPageContinueCursor', cursor_id: 'c1', graph_snapshot_id: 'gs1' }) } } });
        }
        if (String(url).includes('/GetInboxPageRequestQuery')) {
            return response({ body: { data: { get_inbox_page: inboxPage([directConversation('100:300')]) } } });
        }
        throw new Error(`unexpected url ${url}`);
    };
    const transport = createXChatTransport({ client, fetchImpl: http });
    const inbox = await transport.getInbox({ limit: 30 });
    assert.equal(inbox.conversations.length, 2);
    assert.equal(inbox.conversations[0].conversationId, '100:200');
    assert.equal(inbox.conversations[1].conversationId, '100:300');
    assert.equal(inbox.cursor.kind, 'end');
    assert.equal(inbox.maxUserSequenceId, '5000');
    const pageTwoVariables = lastVariables(httpCalls[1]);
    assert.deepEqual(pageTwoVariables.continue_cursor, { cursor_id: 'c1', graph_snapshot_id: 'gs1' });
    assert.equal(pageTwoVariables.include_user_public_keys, true);
});
await test('getConversationEvents pages backwards until has_more is false', async () => {
    const httpCalls = [];
    const http = async (url, init) => {
        httpCalls.push({ url: String(url), init });
        const variables = lastVariables({ init, url: String(url) });
        assert.equal(variables.conversation_id, '100:200');
        assert.equal(variables.min_conversation_key_version, '0');
        if (String(url).includes('/GetConversationPageQuery') && variables.min_local_sequence_id === '5000') {
            return response({ body: { data: { get_conversation_page: { encoded_message_events: ['30', '20', '10'].map(eventB64), missing_conversation_key_change_events: ['k1'], has_more: true } } } });
        }
        if (String(url).includes('/GetConversationPageQuery') && variables.min_local_sequence_id === '10') {
            return response({ body: { data: { get_conversation_page: { encoded_message_events: ['5', '1'].map(eventB64), missing_conversation_key_change_events: [], has_more: false } } } });
        }
        throw new Error(`unexpected page request (min=${variables.min_local_sequence_id})`);
    };
    const transport = createXChatTransport({ client, fetchImpl: http });
    const result = await transport.getConversationEvents({ conversationId: '100:200', maxSequenceId: '5000', limit: 100 });
    assert.equal(result.events.length, 5);
    assert.deepEqual(result.keyChangeEvents, ['k1']);
    assert.equal(result.oldestSequenceId, '10');
    assert.equal(result.truncated, false);
    assert.equal(httpCalls.length, 2);
});
await test('getConversationEvents stops at the limit and reports truncation', async () => {
    const http = async () => response({ body: { data: { get_conversation_page: { encoded_message_events: ['30', '20', '10'].map(eventB64), missing_conversation_key_change_events: [], has_more: true } } } });
    const transport = createXChatTransport({ client, fetchImpl: http });
    const result = await transport.getConversationEvents({ conversationId: '100:200', maxSequenceId: '5000', limit: 4 });
    assert.equal(result.events.length, 6); // one page overshoots, then it stops
    assert.equal(result.truncated, true);
});
await test('sendMessageCreate posts the payload mapping and surfaces error_code', async () => {
    let sent;
    const http = async (url, init) => {
        sent = { url: String(url), init, variables: JSON.parse(init.body).variables };
        return response({ body: { data: { xchat_send_create_message_event: { encoded_message_event: 'EV' } } } });
    };
    const transport = createXChatTransport({ client, fetchImpl: http });
    const result = await transport.sendMessageCreate({
        conversationId: '100:200',
        payload: { messageId: 'm-1', encryptedContent: 'ENC', encodedEventSignature: 'SIG' },
    });
    assert.equal(result.event, 'EV');
    assert.equal(sent.variables.conversation_id, '100:200');
    assert.equal(sent.variables.message_id, 'm-1');
    assert.equal(sent.variables.encoded_message_create_event, 'ENC');
    assert.equal(sent.variables.encoded_message_event_signature, 'SIG');
    assert.equal(sent.init.method, 'POST');
    const failing = async () => response({ body: { data: { xchat_send_create_message_event: { error_code: 13 } } } });
    const failingTransport = createXChatTransport({ client, fetchImpl: failing });
    await assert.rejects(() => failingTransport.sendMessageCreate({ conversationId: '100:200', payload: { messageId: 'm', encryptedContent: 'E', encodedEventSignature: 'S' } }), (error) => {
        assert.match(error.message, /error_code 13/);
        return true;
    });
});
await test('addConversationKeys posts the key change and surfaces error_code', async () => {
    const http = async (url, init) => {
        const variables = JSON.parse(init.body).variables;
        assert.equal(variables.conversation_id, '100:200');
        assert.equal(variables.conversation_participant_keys[0].user_id, '200');
        return response({ body: { data: { xchat_add_encrypted_conversation_key: { conversation_key_change_sequence_id: '9' } } } });
    };
    const transport = createXChatTransport({ client, fetchImpl: http });
    const result = await transport.addConversationKeys({
        conversationId: '100:200',
        change: { conversationKeyVersion: '77', participantKeys: [{ userId: '200', encryptedKey: 'EK', publicKeyVersion: '2' }] },
        signingPublicKey: 'SK',
    });
    assert.equal(result.sequenceId, '9');
});
await test('uploadMedia initializes, posts ton segments (with retry) and finalizes', async () => {
    const httpCalls = [];
    let tonFirstTryFailed = false;
    const http = async (url, init) => {
        const target = String(url);
        httpCalls.push({ target, init, variables: init?.body && typeof init.body === 'string' ? JSON.parse(init.body).variables : null });
        if (target.includes('/InitializeXChatMediaUploadMutation')) {
            return response({ body: { data: { xchat_initialize_media_upload: { media_hash_key: 'MHK', resume_id: 42, resume_upload_url: 'ignored' } } } });
        }
        if (target.startsWith('https://ton.x.com/i/ton/data/xchat_media/')) {
            if (!tonFirstTryFailed) {
                tonFirstTryFailed = true;
                return response({ status: 500, body: 'boom' });
            }
            assert.equal(init.headers['content-type'], 'application/octet-stream');
            assert.ok(init.body instanceof Uint8Array);
            return response({ status: 200, body: '' });
        }
        if (target.includes('/FinalizeXChatMediaUploadMutation')) {
            return response({ body: { data: { xchat_finalize_media_upload: {} } } });
        }
        throw new Error(`unexpected url ${target}`);
    };
    const transport = createXChatTransport({ client, fetchImpl: http });
    const bytes = new Uint8Array(5 * 1024 * 1024 + 10);
    const result = await transport.uploadMedia({ conversationId: '100:200', bytes, contentType: 'image/png' });
    assert.equal(result.mediaHashKey, 'MHK');
    assert.equal(result.numParts, 2);
    assert.match(result.messageId, /^[0-9a-f-]{36}$/);
    const initCall = httpCalls.find((call) => call.target.includes('/InitializeXChatMediaUploadMutation'));
    assert.equal(initCall.variables.conversation_id, '100:200');
    assert.equal(initCall.variables.total_bytes, String(bytes.length));
    assert.equal(initCall.variables.content_type, 'image/png');
    const finalizeCall = httpCalls.find((call) => call.target.includes('/FinalizeXChatMediaUploadMutation'));
    assert.equal(finalizeCall.variables.media_hash_key, 'MHK');
    assert.equal(finalizeCall.variables.num_parts, '2');
    assert.equal(finalizeCall.variables.conversation_id, '100:200');
    const tonCalls = httpCalls.filter((call) => call.target.startsWith('https://ton.x.com'));
    assert.equal(tonCalls.length, 3); // one failed try + two good segments
    assert.match(tonCalls[0].target, /\/100%3A200\/MHK\?concurrent=true&resumeId=42&partNumber=1$/);
    assert.match(tonCalls[2].target, /partNumber=2$/);
    assert.equal(tonCalls[2].init.body.length, bytes.length - 4 * 1024 * 1024);
});
await test('downloadMedia tries the colon form, falls back to the hyphen form on 404', async () => {
    const urls = [];
    const http = async (url) => {
        urls.push(String(url));
        if (urls.length === 1) {
            assert.match(String(url), /\/100%3A200\/HASH$/);
            return response({ status: 404, body: 'gone' });
        }
        assert.match(String(url), /\/100-200\/HASH$/);
        return response({ status: 200, body: new TextEncoder().encode('cipher').buffer });
    };
    const transport = createXChatTransport({ client, fetchImpl: http });
    const bytes = await transport.downloadMedia({ conversationId: '100:200', mediaHashKey: 'HASH' });
    assert.equal(Buffer.from(bytes).toString(), 'cipher');
    assert.equal(urls.length, 2);
});
await test('downloadMedia maps a 401 to a cookie error and a 404 on both forms to not-found', async () => {
    const unauthorized = createXChatTransport({ client, fetchImpl: async () => response({ status: 401, body: 'no' }) });
    await assert.rejects(() => unauthorized.downloadMedia({ conversationId: '100:200', mediaHashKey: 'H' }), /refresh your cookies/);
    const missing = createXChatTransport({ client, fetchImpl: async () => response({ status: 404, body: 'gone' }) });
    await assert.rejects(() => missing.downloadMedia({ conversationId: '100:200', mediaHashKey: 'H' }), /was not found/);
});

// ---- CLI registration -----------------------------------------------------------------------------------
await test('registerChatCommands registers every chat subcommand without loading WASM', () => {
    const identity = (t) => String(t);
    const fakeCtx = {
        p: () => '', l: () => '',
        colors: new Proxy({}, { get: () => identity }),
    };
    const program = new Command();
    registerChatCommands(program, fakeCtx);
    const chat = program.commands.find((command) => command.name() === 'chat');
    assert.ok(chat, 'chat command registered');
    const names = chat.commands.map((command) => command.name());
    assert.deepEqual(names, ['unlock', 'forget', 'inbox', 'read', 'send', 'reply', 'react', 'edit', 'dl']);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exitCode = 1;
}
