// Offline X Chat tests: real chat-xdk crypto between two throwaway identities, no network, no PIN.
// Run: node tests/xchat-tests.mjs
import assert from 'node:assert/strict';
import { hkdfSync, randomBytes } from 'node:crypto';
import nacl from 'tweetnacl';

import { createEngine } from '../dist/lib/xchat/engine.js';
import { conversationIdForms, decryptEvents, normalizeSigningKeys } from '../dist/lib/xchat/decode.js';
import { readBase64Struct, readStruct, union } from '../dist/lib/xchat/thrift.js';

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

// ---- minimal Thrift binary writer for building events around chat-xdk payloads -------------------------
const T = { BOOL: 2, I16: 6, I32: 8, I64: 10, STRING: 11, STRUCT: 12, LIST: 15 };
function encodeValue(type, value) {
    switch (type) {
        case T.BOOL:
            return Uint8Array.of(value ? 1 : 0);
        case T.I16: {
            const b = Buffer.alloc(2);
            b.writeInt16BE(value);
            return b;
        }
        case T.I32: {
            const b = Buffer.alloc(4);
            b.writeInt32BE(value);
            return b;
        }
        case T.I64: {
            const b = Buffer.alloc(8);
            b.writeBigInt64BE(BigInt(value));
            return b;
        }
        case T.STRING: {
            const bytes = Buffer.from(value);
            const len = Buffer.alloc(4);
            len.writeInt32BE(bytes.length);
            return Buffer.concat([len, bytes]);
        }
        case T.STRUCT:
            return Array.isArray(value) ? struct(value) : Buffer.from(value);
        case T.LIST: {
            const head = Buffer.alloc(5);
            head.writeUInt8(value.type, 0);
            head.writeInt32BE(value.items.length, 1);
            return Buffer.concat([head, ...value.items.map((item) => encodeValue(value.type, item))]);
        }
        default:
            throw new Error(`unsupported type ${type}`);
    }
}
function struct(fields) {
    const parts = [];
    for (const [id, type, value] of fields) {
        if (value !== undefined) {
            parts.push(Uint8Array.of(type, (id >> 8) & 0xff, id & 0xff), encodeValue(type, value));
        }
    }
    parts.push(Uint8Array.of(0));
    return Buffer.concat(parts);
}
const toB64 = (bytes) => Buffer.from(bytes).toString('base64');
function messageEvent({ seq, messageId, senderId, conversationId, detail, signature, createdAt = '1760000000000' }) {
    return toB64(struct([
        [1, T.STRING, seq], [2, T.STRING, messageId], [3, T.STRING, senderId], [4, T.STRING, conversationId],
        [6, T.STRING, createdAt], [7, T.STRUCT, detail], [9, T.STRUCT, signature],
    ]));
}
const fromPayload = (payload, seq, senderId, conversationId) => messageEvent({
    seq, messageId: payload.messageId, senderId, conversationId,
    detail: struct([[1, T.STRUCT, Buffer.from(payload.encryptedContent, 'base64')]]),
    signature: Buffer.from(payload.encodedEventSignature, 'base64'),
});
// An unsigned MessageCreateEvent whose contents we encrypt ourselves (for entries chat-xdk can't build).
function sealedEntryEvent({ seq, senderId, conversationId, key, keyVersion, holder, perMessage = false }) {
    const messageId = `m-${seq}`;
    const boxKey = perMessage ? new Uint8Array(hkdfSync('sha256', key, 'xchat-message-key', `${senderId}:${messageId}`, 32)) : key;
    const nonce = randomBytes(24);
    const sealed = nacl.secretbox(holder, nonce, boxKey);
    const mce = [[100, T.STRING, Buffer.concat([nonce, sealed])], [101, T.STRING, keyVersion]];
    if (perMessage) {
        mce.push([112, T.I16, 1]);
    }
    return messageEvent({ seq, messageId, senderId, conversationId, detail: struct([[1, T.STRUCT, mce]]), signature: struct([]) });
}

// ---- two identities and a conversation ------------------------------------------------------------------
const ALICE = '1001';
const BOB = '1002';
const CONV = '1001:1002';
async function identity(userId, keyVersion) {
    const engine = await createEngine();
    const registration = engine.generateKeypairs().publicKey;
    engine.setIdentity(userId, keyVersion);
    return {
        engine,
        // The X API shape (identity key under `public_key`), to exercise normalisation.
        apiKey: {
            user_id: userId, public_key_version: keyVersion, public_key: registration.publicKey,
            signing_public_key: registration.signingPublicKey, identity_public_key_signature: registration.identityPublicKeySignature,
        },
        identityKey: registration.publicKey,
        keyVersion,
    };
}
const alice = await identity(ALICE, '5001');
const bob = await identity(BOB, '5002');
const signingKeys = { data: [alice.apiKey, bob.apiKey] };
const change = alice.engine.prepareConversationKeyChange({
    publicKeys: [
        { userId: ALICE, publicKey: alice.identityKey, keyVersion: alice.keyVersion },
        { userId: BOB, publicKey: bob.identityKey, keyVersion: bob.keyVersion },
    ],
});
const actionSig = change.actionSignatures[0];
const keyChangeEvent = messageEvent({
    seq: '100', messageId: actionSig.messageId, senderId: ALICE, conversationId: CONV,
    detail: Buffer.from(actionSig.encodedMessageEventDetail, 'base64'),
    signature: struct([[1, T.STRING, actionSig.signature], [2, T.STRING, actionSig.publicKeyVersion], [3, T.STRING, actionSig.signatureVersion]]),
});
const convKey = change.conversationKey;
const keyVersion = change.conversationKeyVersion;
const hello = alice.engine.encryptMessage({
    conversationId: '1002-1001', text: 'hello @bob https://x.com/i/chat',
    conversationKey: convKey, conversationKeyVersion: keyVersion,
});
const helloEvent = fromPayload(hello, '101', ALICE, CONV);
// Warm alice's verified-key cache, then build reactions, replies and edits the way BirdGang will.
decryptEvents(alice.engine, { events: [keyChangeEvent, helloEvent], signingKeys });
const reaction = fromPayload(alice.engine.encryptAddReaction({ emoji: '🔥', targetEvent: helloEvent }), '102', ALICE, CONV);
const reply = fromPayload(alice.engine.encryptReply({ conversationId: CONV, text: 'replying', replyToEvent: helloEvent }), '103', ALICE, CONV);
const edit = fromPayload(alice.engine.encryptEdit({ updatedText: 'hello again', targetEvent: helloEvent }), '104', ALICE, CONV);

console.log('xchat — thrift reader');
await test('reads a MessageEvent envelope and its detail union', () => {
    const event = readBase64Struct(helloEvent);
    assert.equal(Buffer.from(event[1]).toString(), '101');
    assert.equal(union(event[7])[0], 1);
});
await test('rejects truncated and oversized input instead of reading past the end', () => {
    assert.throws(() => readStruct(Uint8Array.of(11, 0, 1, 0, 0, 0, 9, 65)), /Truncated/);
    assert.throws(() => readStruct(Uint8Array.of(15, 0, 1, 12, 0x7f, 0xff, 0xff, 0xff)), /collection size/);
});

console.log('xchat — ids and signing keys');
await test('conversation ids canonicalise to numeric order in both forms', () => {
    assert.deepEqual(conversationIdForms('1002-1001'), { colon: '1001:1002', hyphen: '1001-1002', participants: ['1001', '1002'] });
    assert.equal(conversationIdForms('99:1000').colon, '99:1000');
    assert.equal(conversationIdForms('g1234567').hyphen, 'g1234567');
});
await test('signing keys normalise from the API shape and report incomplete or forged entries', () => {
    const forged = { ...bob.apiKey, public_key_version: '9', signing_public_key: alice.apiKey.signing_public_key };
    const { keys, skipped } = normalizeSigningKeys({ data: [alice.apiKey, alice.apiKey, { user_id: '7' }, forged] }, bob.engine);
    assert.equal(keys.length, 1);
    assert.equal(keys[0].identityPublicKey, alice.identityKey);
    assert.deepEqual(skipped.map((s) => s.reason), [
        'missing publicKeyVersion, publicKey, identityPublicKey, identityPublicKeySignature',
        'identity binding signature does not verify',
    ]);
});

console.log('xchat — decrypt (real chat-xdk crypto)');
const decoded = decryptEvents(bob.engine, { events: [helloEvent, reaction, reply, edit, helloEvent], keyChangeEvents: [keyChangeEvent], signingKeys });
const bySeq = new Map(decoded.rows.map((row) => [row.sequenceId, row]));
await test('one row per unique event, oldest first, duplicates dropped', () => {
    assert.deepEqual(decoded.rows.map((row) => row.sequenceId), ['100', '101', '102', '103', '104']);
});
await test('key change becomes a verified notice', () => {
    assert.deepEqual([bySeq.get('100').kind, bySeq.get('100').status, bySeq.get('100').notice], ['keyChange', 'verified', '[conversation key changed]']);
});
await test('message decrypts, verifies and keeps sender and conversation', () => {
    const row = bySeq.get('101');
    assert.deepEqual([row.text, row.status, row.senderId, row.conversationId], ['hello @bob https://x.com/i/chat', 'verified', ALICE, CONV]);
    assert.equal(row.createdAt, '2025-10-09T08:53:20.000Z');
});
await test('reaction, reply and edit get readable text and targets', () => {
    assert.equal(bySeq.get('102').text, 'reacted 🔥 to 101');
    assert.deepEqual([bySeq.get('103').text, bySeq.get('103').replyTo.sequenceId, bySeq.get('103').replyTo.text], ['replying', '101', 'hello @bob https://x.com/i/chat']);
    assert.deepEqual([bySeq.get('104').kind, bySeq.get('104').text], ['edit', 'edited 101: hello again']);
});
await test('without signing keys messages still decrypt but are unverified', async () => {
    const fresh = await createEngine();
    const secret = bob.engine.exportKeys();
    fresh.importKeys(secret, bob.keyVersion);
    secret.fill(0);
    const plain = decryptEvents(fresh, { events: [helloEvent], keyChangeEvents: [keyChangeEvent] });
    const row = plain.rows.find((r) => r.sequenceId === '101');
    assert.deepEqual([row.text, row.status], ['hello @bob https://x.com/i/chat', 'unverified']);
});

console.log('xchat — gaps chat-xdk 0.5.2 leaves (X wire schema)');
const callEnded = struct([[1, T.STRUCT, [[10, T.STRUCT, [[2, T.I64, 65], [3, T.BOOL, false]]]]]]);
const nickname = struct([[1, T.STRUCT, [[14, T.STRUCT, [[1, T.I64, 1002], [2, T.STRING, 'Bobby']]]]]]);
const secretText = struct([[1, T.STRUCT, [[1, T.STRUCT, [[1, T.STRING, 'per-message secret']]]]]]);
const grokReply = messageEvent({ seq: '106', messageId: 'g-1', senderId: '777', conversationId: CONV, signature: struct([]),
    detail: struct([[16, T.STRUCT, [[6, T.STRING, 'Here is the summary.'], [10, T.STRING, '101']]]]) });
const pin = messageEvent({ seq: '107', messageId: 'p-1', senderId: ALICE, conversationId: CONV, signature: struct([]),
    detail: struct([[17, T.STRUCT, [[4, T.I64, 101]]]]) });
const description = messageEvent({ seq: '108', messageId: 'd-1', senderId: ALICE, conversationId: CONV, signature: struct([]),
    detail: struct([[4, T.STRUCT, [[1, T.STRUCT, [[14, T.STRUCT, [[1, T.STRING, alice.engine.encrypt('Weekend plans', convKey)], [2, T.STRING, keyVersion]]]]]]]]) });
const archived = messageEvent({ seq: '109', messageId: 'a-1', senderId: ALICE, conversationId: CONV, signature: struct([]),
    detail: struct([[9, T.STRUCT, [[1, T.STRUCT, [[11, T.STRUCT, [[1, T.LIST, { type: T.STRING, items: [CONV] }]]]]]]]]) });
const gaps = decryptEvents(bob.engine, {
    keyChangeEvents: [keyChangeEvent],
    signingKeys,
    events: [
        helloEvent,
        sealedEntryEvent({ seq: '105', senderId: ALICE, conversationId: CONV, key: convKey, keyVersion, holder: callEnded }),
        grokReply, pin, description, archived,
        sealedEntryEvent({ seq: '110', senderId: BOB, conversationId: CONV, key: convKey, keyVersion, holder: nickname }),
        sealedEntryEvent({ seq: '111', senderId: ALICE, conversationId: CONV, key: convKey, keyVersion, holder: secretText, perMessage: true }),
        'not a real event',
    ],
});
const gap = new Map(gaps.rows.map((row) => [row.sequenceId, row]));
await test('calls and other entries the SDK drops are opened and labelled', () => {
    assert.equal(gap.get('105').text, '[call ended, 1m 5s]');
    assert.equal(gap.get('110').text, '[set nickname for 1002: Bobby]');
});
await test('Grok replies keep their plaintext and reply target', () => {
    assert.deepEqual([gap.get('106').kind, gap.get('106').text, gap.get('106').replyTo.sequenceId], ['grokResponse', 'Here is the summary.', '101']);
});
await test('pins quote the message they pinned', () => {
    assert.equal(gap.get('107').notice, '[pinned 101: "hello @bob https://x.com/i/chat"]');
});
await test('encrypted group descriptions are opened with their key version', () => {
    assert.equal(gap.get('108').notice, '[changed the group description to "Weekend plans"]');
    assert.equal(gap.get('108').change.description, 'Weekend plans');
});
await test('archive notices come from the metadata variants the SDK omits', () => {
    assert.equal(gap.get('109').notice, '[archived the conversation]');
});
await test('per-message-key messages decrypt through the derived key', () => {
    assert.equal(gap.get('111').text, 'per-message secret');
    assert.equal(gap.get('111').status, 'unverified');
});
await test('undecodable input becomes an error row, not a crash', () => {
    const bad = gaps.rows.find((row) => row.error);
    assert.match(bad.error, /Malformed event/);
    assert.ok(gaps.unverifiedSenders.includes(ALICE));
});

console.log('xchat — send (real chat-xdk crypto)');
{
    const { prepareSend, prepareFirstContact } = await import('../dist/lib/xchat/send.js');
    const { encryptImage, saveDecryptedMedia } = await import('../dist/lib/xchat/media.js');
    const { mkdtemp, readFile, rm, stat } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = (await import('node:path')).default;
    const aliceView = decryptEvents(alice.engine, { events: [keyChangeEvent, helloEvent], signingKeys });
    const readBack = (...events) => {
        const out = decryptEvents(bob.engine, { events, keyChangeEvents: [keyChangeEvent], signingKeys });
        return new Map(out.rows.map((row) => [row.sequenceId, row]));
    };
    await test('a message carries link and mention entities and reads back verified', () => {
        const sent = prepareSend(alice.engine, aliceView, { conversationId: '1001-1002', text: 'ping @bob about #launch https://x.com' });
        assert.deepEqual([sent.action, sent.conversationId, sent.uploadConversationId], ['message', '1001-1002', '1001:1002']);
        const row = readBack(fromPayload(sent.payload, '201', ALICE, CONV)).get('201');
        assert.deepEqual([row.text, row.status], ['ping @bob about #launch https://x.com', 'verified']);
        assert.deepEqual(row.entities.map((e) => [e.startIndex, e.endIndex]), [[5, 9], [16, 23], [24, 37]]);
    });
    await test('reply, reaction, reaction removal and edit target a fetched message', () => {
        const replyTo = prepareSend(alice.engine, aliceView, { conversationId: CONV, text: 'on it', replyTo: '101' });
        const react = prepareSend(alice.engine, aliceView, { conversationId: CONV, react: { emoji: '👍', target: '101' } });
        const unreact = prepareSend(alice.engine, aliceView, { conversationId: CONV, react: { emoji: '👍', target: hello.messageId, remove: true } });
        const edited = prepareSend(alice.engine, aliceView, { conversationId: CONV, text: 'hello, edited', edit: '101' });
        assert.deepEqual([replyTo.action, react.action, unreact.action, edited.action], ['reply', 'reaction', 'reaction_removed', 'edit']);
        assert.equal(unreact.targetSequenceId, '101');
        const rows = readBack(
            fromPayload(replyTo.payload, '202', ALICE, CONV), fromPayload(react.payload, '203', ALICE, CONV),
            fromPayload(unreact.payload, '204', ALICE, CONV), fromPayload(edited.payload, '205', ALICE, CONV),
        );
        assert.deepEqual(['202', '203', '204', '205'].map((seq) => rows.get(seq).text), ['on it', 'reacted 👍 to 101', 'removed 👍 from 101', 'edited 101: hello, edited']);
    });
    await test('invalid sends are refused before anything is encrypted', () => {
        assert.throws(() => prepareSend(alice.engine, aliceView, { conversationId: CONV, text: 'x', replyTo: '101', edit: '101' }), /only one of/);
        assert.throws(() => prepareSend(alice.engine, aliceView, { conversationId: CONV, text: 'x', react: { emoji: '👍', target: '101' } }), /no text/);
        assert.throws(() => prepareSend(alice.engine, aliceView, { conversationId: CONV }), /Nothing to send/);
        assert.throws(() => prepareSend(alice.engine, aliceView, { conversationId: CONV, text: 'x', replyTo: '999' }), /not in the fetched conversation/);
    });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    await test('an image is encrypted into parts, sent as a photo, and decrypts back to the same bytes privately', async () => {
        const image = await encryptImage(alice.engine, { bytes: png, filename: 'dot.png', key: convKey, keyVersion, partBytes: 1 });
        assert.deepEqual([image.mimeType, image.width, image.height, image.parts.length], ['image/png', 1, 1, 1]);
        const sent = prepareSend(alice.engine, aliceView, { conversationId: CONV, text: 'look', images: [{ ...image, mediaHashKey: 'AGgkIbPRTG' }] });
        const row = readBack(fromPayload(sent.payload, '206', ALICE, CONV)).get('206');
        assert.equal(row.text, '[photo] look');
        assert.equal(row.attachments[0].mediaHashKey, 'AGgkIbPRTG');
        const dir = await mkdtemp(path.join(tmpdir(), 'bg-media-'));
        try {
            const saved = await saveDecryptedMedia(bob.engine, { bytes: Buffer.concat(image.parts), key: convKey, outDir: path.join(dir, 'out'), baseName: '206' });
            assert.deepEqual(await readFile(saved.path), png);
            assert.equal((await stat(saved.path)).mode & 0o777, 0o600);
        }
        finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
    await test('an image encrypted under another key version is refused', async () => {
        const image = await encryptImage(alice.engine, { bytes: png, filename: 'dot.png', key: convKey, keyVersion: '1' });
        assert.throws(() => prepareSend(alice.engine, aliceView, { conversationId: CONV, images: [{ ...image, mediaHashKey: 'k' }] }), /encrypted under conversation key 1/);
        await assert.rejects(encryptImage(alice.engine, { bytes: Buffer.from('GIF87a nope'), filename: 'x.txt', key: convKey, keyVersion }), /could not read|only PNG/);
    });
    await test('first contact makes a key change both sides verify, then a message under it', () => {
        const carol = '1003';
        const first = prepareFirstContact(alice.engine, {
            conversationId: `${carol}-${ALICE}`,
            publicKeys: [
                { userId: ALICE, identityPublicKey: alice.identityKey, publicKeyVersion: alice.keyVersion },
                { userId: carol, identityPublicKey: bob.identityKey, publicKeyVersion: bob.keyVersion },
            ],
        });
        const sig = first.change.actionSignatures[0];
        const kcEvent = messageEvent({
            seq: '300', messageId: sig.messageId, senderId: ALICE, conversationId: '1001:1003',
            detail: Buffer.from(sig.encodedMessageEventDetail, 'base64'),
            signature: struct([[1, T.STRING, sig.signature], [2, T.STRING, sig.publicKeyVersion], [3, T.STRING, sig.signatureVersion]]),
        });
        const sent = prepareSend(alice.engine, { raw: { bySequence: new Map(), byMessageId: new Map(), keyChanges: [] }, rows: [] },
            { conversationId: `${carol}-${ALICE}`, text: 'first!', conversationKey: first.conversationKey });
        const out = decryptEvents(bob.engine, { events: [fromPayload(sent.payload, '301', ALICE, '1001:1003')], keyChangeEvents: [kcEvent], signingKeys });
        assert.deepEqual(out.rows.map((row) => [row.kind, row.status, row.text || row.notice]), [
            ['keyChange', 'verified', '[conversation key changed]'],
            ['message', 'verified', 'first!'],
        ]);
    });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
