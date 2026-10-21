// ABOUTME: Turns raw X Chat events into readable rows: chat-xdk decrypts and verifies, X's wire schema fills its gaps.
// ABOUTME: Every event yields one row with display text or a notice, a status, or an error; nothing is silently dropped.
import { hkdfSync } from 'node:crypto';
import nacl from 'tweetnacl';
import { ident, num, readBase64Struct, readStruct, text, union } from './thrift.js';
// MessageEventDetail variants (X's schema; chat-xdk 0.5.2 returns 10 and 15–19 as `unknown`).
const DETAIL = { MESSAGE: 1, KEY_CHANGE: 3, GROUP_CHANGE: 4, GROK_SEARCH: 10, GROK_MESSAGE: 15, GROK_RESPONSE: 16, PIN: 17, UNPIN: 18, PIN_KEYS: 19 };
// MessageEntryContents variants the SDK returns as content `unknown`.
const ENTRY = {
    PIN_CONVERSATION: 7, UNPIN_CONVERSATION: 8, SCREEN_CAPTURE: 9, CALL_ENDED: 10, CALL_MISSED: 11, DRAFT: 12,
    ACCEPT_REQUEST: 13, NICKNAME: 14, VERIFIED_STATUS: 15, CALL_STARTED: 16, X_NUMBER_USED: 17,
};
const ATTACHMENT_LABELS = { image: '[photo]', gif: '[GIF]', video: '[video]', audio: '[audio]', svg: '[image]' };
const FAILURES = {
    contentsTooLarge: 'message too large', tooManyMessages: 'too many messages', invalidSenderSignature: 'invalid signature',
    nonLatestCkeyVersion: 'conversation key out of date', recipientHasNotTrustedConversation: 'recipient has not accepted',
    recipientKeyHasChanged: "recipient's key changed", onlyEncryptedMessagesAllowed: 'only encrypted messages allowed',
    requesterNotAdmin: 'not a group admin', flaggedAsSpam: 'flagged as spam', rateLimitUpsell: 'rate limited',
    senderNotGroupMember: 'not a group member', tooManyPins: 'too many pins',
};
// ---- conversation ids ---------------------------------------------------------------------------------
const isDigits = (value) => /^\d+$/.test(value);
const numericFirst = (a, b) => (a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0);
/** Canonical forms of a conversation id: colon (events, media upload) and hyphen (send, keys). */
export function conversationIdForms(conversationId) {
    const id = String(conversationId ?? '').trim();
    const pair = id.split(/[:-]/);
    if (pair.length === 2 && pair.every(isDigits)) {
        const [a, b] = pair.sort(numericFirst);
        return { colon: `${a}:${b}`, hyphen: `${a}-${b}`, participants: [a, b] };
    }
    return { colon: id, hyphen: id, participants: [] };
}
// ---- signing keys -------------------------------------------------------------------------------------
function pick(source, ...names) {
    for (const name of names) {
        const value = source?.[name];
        if (value !== undefined && value !== null && value !== '') {
            return typeof value === 'number' || typeof value === 'bigint' ? String(value) : value;
        }
    }
    return undefined;
}
const KEY_FIELDS = ['public_key', 'publicKey', 'signing_public_key', 'signingPublicKey', 'identityPublicKey', 'identity_public_key'];
function* keyCandidates(input, userHint) {
    if (Array.isArray(input)) {
        for (const item of input) {
            yield* keyCandidates(item, userHint);
        }
        return;
    }
    if (!input || typeof input !== 'object') {
        return;
    }
    const nested = input.data ?? input.public_keys ?? input.publicKeys ?? input.keys;
    if (KEY_FIELDS.some((field) => field in input) || (!nested && ('user_id' in input || 'userId' in input))) {
        yield { raw: input, userHint };
        return;
    }
    if (nested) {
        yield* keyCandidates(nested, pick(input, 'user_id', 'userId', 'id') ?? userHint);
        return;
    }
    for (const [key, value] of Object.entries(input)) {
        if (isDigits(key)) {
            yield* keyCandidates(value, key);
        }
    }
}
/**
 * Normalise signing keys from any X shape (API `{data:[…]}`, per-user maps, snake_case or SDK camelCase) into
 * chat-xdk entries. Incomplete entries and bad identity bindings are reported in `skipped` instead of making
 * the SDK throw for the whole batch.
 */
export function normalizeSigningKeys(input, engine) {
    const keys = [];
    const skipped = [];
    const seen = new Set();
    for (const { raw, userHint } of keyCandidates(input)) {
        // SDK entries name the signing key `publicKey`; API entries name the identity key `public_key`.
        const sdkShaped = 'identityPublicKey' in raw || 'identity_public_key' in raw;
        const entry = {
            userId: pick(raw, 'user_id', 'userId') ?? userHint,
            publicKeyVersion: pick(raw, 'public_key_version', 'publicKeyVersion', 'key_version', 'keyVersion', 'version'),
            publicKey: sdkShaped ? pick(raw, 'publicKey', 'signing_public_key', 'signingPublicKey') : pick(raw, 'signing_public_key', 'signingPublicKey'),
            identityPublicKey: sdkShaped ? pick(raw, 'identityPublicKey', 'identity_public_key') : pick(raw, 'public_key', 'publicKey'),
            identityPublicKeySignature: pick(raw, 'identity_public_key_signature', 'identityPublicKeySignature'),
        };
        const missing = Object.keys(entry).filter((field) => typeof entry[field] !== 'string');
        const label = { userId: entry.userId ?? null, publicKeyVersion: entry.publicKeyVersion ?? null };
        if (missing.length > 0) {
            skipped.push({ ...label, reason: `missing ${missing.join(', ')}` });
            continue;
        }
        const dedupeKey = `${entry.userId}:${entry.publicKeyVersion}`;
        if (seen.has(dedupeKey)) {
            continue;
        }
        seen.add(dedupeKey);
        if (engine && !engine.verifyKeyBinding(entry.identityPublicKey, entry.publicKey, entry.identityPublicKeySignature)) {
            skipped.push({ ...label, reason: 'identity binding signature does not verify' });
            continue;
        }
        keys.push(entry);
    }
    return { keys, skipped };
}
// ---- raw event access ---------------------------------------------------------------------------------
function rawMeta(b64) {
    const event = readBase64Struct(b64);
    const [variant, detail] = union(event[7]);
    return {
        sequenceId: ident(event[1]),
        messageId: ident(event[2]),
        senderId: ident(event[3]),
        conversationId: ident(event[4]),
        createdAtMsec: ident(event[6]),
        variant,
        detail,
    };
}
function openBox(box, key) {
    if (!(box instanceof Uint8Array) || box.length < 40 || !key) {
        return null;
    }
    return nacl.secretbox.open(box.subarray(24), box.subarray(0, 24), key);
}
function perMessageKey(conversationKey, senderId, messageId) {
    return new Uint8Array(hkdfSync('sha256', conversationKey, 'xchat-message-key', `${senderId}:${messageId}`, 32));
}
function keysNewestFirst(keyMap) {
    return Object.keys(keyMap ?? {}).sort((a, b) => numericFirst(b, a)).map((version) => [version, keyMap[version]]);
}
function openText(engine, ciphertext, version, keyMap) {
    if (typeof ciphertext !== 'string' || ciphertext.length === 0) {
        return undefined;
    }
    const candidates = keysNewestFirst(keyMap);
    if (version && keyMap?.[version]) {
        candidates.unshift([version, keyMap[version]]);
    }
    for (const [, key] of candidates) {
        try {
            return engine.decrypt(ciphertext, key);
        }
        catch {
            // wrong key; Poly1305 rejects it safely
        }
    }
    return undefined;
}
// ---- display text -------------------------------------------------------------------------------------
function duration(seconds) {
    const s = Math.max(0, Math.round(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return [h && `${h}h`, m && `${m}m`, (s % 60 || (!h && !m)) && `${s % 60}s`].filter(Boolean).join(' ');
}
function ttl(msec) {
    const s = Math.round(Number(msec) / 1000);
    if (s % 86_400 === 0) {
        const days = s / 86_400;
        return days % 7 === 0 ? `${days / 7}w` : `${days}d`;
    }
    return s % 3600 === 0 ? `${s / 3600}h` : duration(s);
}
const names = (ids) => (ids ?? []).map(String).join(', ');
function attachmentLabel(attachment, bodyText) {
    switch (attachment.attachmentType) {
        case 'media':
            return attachment.mediaType === 'file' || !ATTACHMENT_LABELS[attachment.mediaType]
                ? `[file${attachment.filename ? `: ${attachment.filename}` : ''}]`
                : ATTACHMENT_LABELS[attachment.mediaType];
        case 'url':
            return attachment.url && bodyText.includes(attachment.url) ? null : `[link${attachment.url ? `: ${attachment.url}` : ''}]`;
        case 'post':
            return `[post${attachment.postUrl ? `: ${attachment.postUrl}` : attachment.restId ? `: ${attachment.restId}` : ''}]`;
        case 'unifiedCard':
            return '[card]';
        case 'money':
            return '[payment]';
        default:
            return '[attachment]';
    }
}
function messageText(event) {
    const content = event.content ?? {};
    const body = content.text || content.forwardedMessage?.messageText || '';
    const labels = (event.attachments ?? []).map((attachment) => attachmentLabel(attachment, body)).filter(Boolean);
    const forwarded = !content.text && content.forwardedMessage?.messageText ? '[forwarded] ' : '';
    const joined = [...labels, `${forwarded}${body}`.trim()].filter(Boolean).join(' ');
    return joined || '[empty message]';
}
function entryText(entryId, entry) {
    switch (entryId) {
        case ENTRY.PIN_CONVERSATION:
            return '[pinned the conversation]';
        case ENTRY.UNPIN_CONVERSATION:
            return '[unpinned the conversation]';
        case ENTRY.SCREEN_CAPTURE:
            return num(entry?.[1]) === 2 ? '[recorded the screen]' : '[took a screenshot]';
        case ENTRY.CALL_STARTED:
            return entry?.[1] ? '[audio call started]' : '[call started]';
        case ENTRY.CALL_ENDED:
            return `[${entry?.[3] ? 'audio call' : 'call'} ended${entry?.[2] !== undefined ? `, ${duration(num(entry[2]))}` : ''}]`;
        case ENTRY.CALL_MISSED:
            return entry?.[2] ? '[missed audio call]' : '[missed call]';
        case ENTRY.DRAFT:
            return `[draft: ${text(entry?.[2]) ?? ''}]`;
        case ENTRY.ACCEPT_REQUEST:
            return '[accepted the message request]';
        case ENTRY.NICKNAME:
            return `[set nickname for ${ident(entry?.[1]) ?? 'someone'}${entry?.[2] ? `: ${text(entry[2])}` : ''}]`;
        case ENTRY.VERIFIED_STATUS:
            return `[${entry?.[2] ? 'verified' : 'unverified'} ${ident(entry?.[1]) ?? 'a contact'}]`;
        case ENTRY.X_NUMBER_USED:
            return '[used an X number]';
        default:
            return `[unsupported message type ${entryId ?? 'unknown'}]`;
    }
}
function groupNotice(change, opened) {
    switch (change?.changeType) {
        case 'created':
            return `[created the group${opened.title ? ` "${opened.title}"` : ''}]`;
        case 'titleChanged':
            return opened.title ? `[renamed the group to "${opened.title}"]` : '[renamed the group]';
        case 'avatarChanged':
            return '[changed the group photo]';
        case 'adminsAdded':
            return `[made ${names(change.adminIds)} admin]`;
        case 'adminsRemoved':
            return `[removed ${names(change.adminIds)} as admin]`;
        case 'membersAdded':
            return `[added ${names(change.memberIds)}]`;
        case 'membersRemoved':
            return `[removed ${names(change.memberIds)}]`;
        case 'inviteEnabled':
            return '[turned on the invite link]';
        case 'inviteDisabled':
            return '[turned off the invite link]';
        case 'joinRequested':
            return `[${change.userId ?? 'someone'} asked to join]`;
        case 'joinRejected':
            return `[declined ${names(change.userIds)}]`;
        default:
            if (opened.description !== undefined) {
                return opened.description ? `[changed the group description to "${opened.description}"]` : '[removed the group description]';
            }
            return '[changed the group settings]';
    }
}
const SETTINGS = {
    messageDurationRemoved: '[turned off disappearing messages]', muted: '[muted the conversation]', unmuted: '[unmuted the conversation]',
    screenCaptureDetectionEnabled: '[turned on screenshot alerts]', screenCaptureDetectionDisabled: '[turned off screenshot alerts]',
    screenCaptureBlockingEnabled: '[turned on screenshot blocking]', screenCaptureBlockingDisabled: '[turned off screenshot blocking]',
};
// ConversationMetadataChange variants the SDK reports as `unknown`.
const METADATA = { 9: '[turned on Grok]', 10: '[turned off Grok]', 11: '[archived the conversation]', 12: '[unarchived the conversation]' };
function systemNotice(event, raw) {
    switch (event.type) {
        case 'keyChange':
            return '[conversation key changed]';
        case 'messageDeleted': {
            const count = event.messageIds?.length ?? 0;
            return `[deleted ${count} message${count === 1 ? '' : 's'}${event.deleteForAll ? ' for everyone' : ''}]`;
        }
        case 'conversationDeleted':
            return event.clearAllMessages ? '[cleared the conversation]' : '[deleted the conversation]';
        case 'settingsChange': {
            const setting = event.change?.setting;
            if (setting === 'messageDuration') {
                return `[set disappearing messages to ${ttl(event.change.ttlMsec)}]`;
            }
            const [metadataId] = union(raw?.detail?.[1]);
            return SETTINGS[setting] ?? METADATA[metadataId] ?? '[changed the conversation settings]';
        }
        case 'readReceipt':
            return `[read up to ${event.seenUntilId}]`;
        case 'markedUnread':
            return '[marked unread]';
        case 'typing':
            return '[typing]';
        case 'memberDeleted':
            return `[${event.memberId}'s account was deleted]`;
        case 'failure':
            return `[message failed: ${FAILURES[event.failure] ?? event.failure ?? 'unknown error'}]`;
        default:
            return undefined;
    }
}
// ---- rows ---------------------------------------------------------------------------------------------
function baseRow(meta, event) {
    const createdAtMsec = event?.createdAtMsec ?? meta?.createdAtMsec;
    return {
        sequenceId: event?.sequenceId ?? meta?.sequenceId ?? null,
        messageId: event?.id ?? meta?.messageId ?? null,
        senderId: event?.senderId ?? meta?.senderId ?? null,
        conversationId: event?.conversationId ?? meta?.conversationId ?? null,
        createdAt: createdAtMsec && Number.isFinite(Number(createdAtMsec)) ? new Date(Number(createdAtMsec)).toISOString() : null,
    };
}
function status(event) {
    if (event.type === 'message' && (event.keyVersion === null || event.keyVersion === undefined)) {
        return 'unencrypted';
    }
    return event.verified ? 'verified' : 'unverified';
}
function messageRow(row, event, raw, context) {
    const content = event.content ?? {};
    const out = { ...row, kind: 'message', status: status(event), text: '' };
    if (event.ttlMsec) {
        out.ttlMsec = Number(event.ttlMsec);
    }
    switch (content.contentType) {
        case 'reaction':
        case 'reactionRemoved':
            out.kind = content.contentType;
            out.reaction = { emoji: content.emoji, targetSequenceId: String(content.targetMessageId) };
            out.text = content.contentType === 'reaction'
                ? `reacted ${content.emoji} to ${content.targetMessageId}`
                : `removed ${content.emoji} from ${content.targetMessageId}`;
            return out;
        case 'edit':
            out.kind = 'edit';
            out.edit = { targetSequenceId: String(content.targetMessageId), text: content.newText ?? '' };
            out.text = `edited ${content.targetMessageId}: ${content.newText ?? ''}`;
            return out;
        case 'markRead':
        case 'markUnread':
            out.kind = content.contentType;
            out.text = content.contentType === 'markRead' ? '[marked read]' : '[marked unread]';
            return out;
        case 'unknown': {
            const key = context.keyFor(raw, event.keyVersion);
            const plaintext = openBox(raw?.detail?.[100], key);
            const [entryId, entry] = plaintext ? union(readStruct(plaintext)[1]) : [];
            out.kind = 'entry';
            out.entryType = entryId ?? null;
            out.text = plaintext ? entryText(entryId, entry) : '[unreadable message]';
            return out;
        }
        default:
            break;
    }
    out.text = messageText(event);
    if (content.entities?.length) {
        out.entities = content.entities;
    }
    if (event.attachments?.length) {
        out.attachments = event.attachments;
    }
    const preview = content.replyingToPreview;
    if (preview) {
        out.replyTo = {
            sequenceId: preview.replyingToMessageSequenceId ?? null,
            messageId: preview.replyingToMessageId ?? null,
            senderId: preview.senderId === undefined ? null : String(preview.senderId),
            text: preview.messageText ?? '',
            valid: event.replyPreviewValidation === undefined ? null : event.replyPreviewValidation === 'valid',
        };
    }
    if (content.forwardedMessage) {
        out.forwarded = true;
    }
    return out;
}
function groupRow(row, event, raw, context) {
    const change = { ...(event.change ?? {}) };
    const [variant, detail] = union(raw?.detail?.[1]);
    const keys = context.conversationKeys;
    // Titles, photos and descriptions are encrypted under the conversation key version the change names.
    const opened = {};
    if (variant === 1) {
        opened.title = openText(context.engine, text(detail?.[3]), text(detail?.[5]), keys);
        opened.avatarUrl = openText(context.engine, text(detail?.[4]), text(detail?.[5]), keys);
    }
    else if (variant === 2) {
        opened.title = openText(context.engine, text(detail?.[1]), text(detail?.[2]), keys);
    }
    else if (variant === 3) {
        opened.avatarUrl = openText(context.engine, text(detail?.[1]), text(detail?.[2]), keys);
    }
    else if (variant === 5) {
        opened.title = openText(context.engine, text(detail?.[4]), text(detail?.[6]), keys);
        opened.avatarUrl = openText(context.engine, text(detail?.[5]), text(detail?.[6]), keys);
        opened.description = openText(context.engine, text(detail?.[16]), text(detail?.[6]), keys);
    }
    else if (variant === 14) {
        change.changeType = 'descriptionChanged';
        opened.description = openText(context.engine, text(detail?.[1]), text(detail?.[2]), keys) ?? '';
    }
    for (const [field, value] of Object.entries({ decryptedTitle: opened.title, decryptedAvatarUrl: opened.avatarUrl, description: opened.description })) {
        if (value !== undefined) {
            change[field] = value;
        }
    }
    return { ...row, kind: 'groupChange', status: status(event), text: '', notice: groupNotice(change, opened), change };
}
function unknownEventRow(row, raw, context) {
    const detail = raw?.detail ?? {};
    switch (raw?.variant) {
        case DETAIL.GROK_RESPONSE: {
            const out = { ...row, kind: 'grokResponse', status: 'unencrypted', text: text(detail[6]) || '[Grok replied]' };
            const replyTo = ident(detail[10]);
            if (replyTo) {
                out.replyTo = { sequenceId: replyTo, messageId: ident(detail[11]) ?? null };
            }
            if (detail[12]) {
                out.grokBot = { id: text(detail[12][1]) ?? null, name: text(detail[12][2]) ?? null };
            }
            return out;
        }
        case DETAIL.GROK_MESSAGE:
            return { ...row, kind: 'grokMessage', status: 'unverified', text: '[message to Grok]' };
        case DETAIL.GROK_SEARCH:
            return { ...row, kind: 'grokSearch', status: 'unverified', text: '[Grok search results]' };
        case DETAIL.PIN: {
            const target = ident(detail[4]);
            const pinned = target ? context.textBySequence.get(target) : undefined;
            return { ...row, kind: 'pin', status: 'unverified', text: '', notice: `[pinned ${target ?? 'a message'}${pinned ? `: "${pinned}"` : ''}]`, targetSequenceId: target ?? null };
        }
        case DETAIL.UNPIN: {
            const target = ident(detail[2]);
            return { ...row, kind: 'unpin', status: 'unverified', text: '', notice: `[unpinned ${target ?? 'a message'}]`, targetSequenceId: target ?? null };
        }
        case DETAIL.PIN_KEYS:
            return { ...row, kind: 'pinKeys', status: 'unverified', text: '', notice: '[updated pinned message keys]' };
        default:
            return { ...row, kind: 'unknown', status: 'unverified', text: '', notice: `[unsupported event type ${raw?.variant ?? 'unknown'}]` };
    }
}
function rowFor(meta, event, context) {
    const row = baseRow(meta, event);
    if (event.type === 'message') {
        return messageRow(row, event, meta, context);
    }
    if (event.type === 'groupChange') {
        return groupRow(row, event, meta, context);
    }
    if (event.type === 'unknown') {
        return unknownEventRow(row, meta, context);
    }
    return { ...row, kind: event.type, status: status(event), text: '', notice: systemNotice(event, meta) };
}
const errorRow = (meta, error) => ({
    ...baseRow(meta),
    kind: meta?.variant === DETAIL.MESSAGE ? 'message' : 'unknown',
    status: 'unverified',
    text: meta?.variant === DETAIL.MESSAGE ? '[message could not be decrypted]' : '',
    notice: meta?.variant === DETAIL.MESSAGE ? undefined : '[event could not be read]',
    error,
});
/**
 * Decrypt a conversation's events into rows, oldest sequence first.
 * `events` and `keyChangeEvents` are base64 MessageEvents; duplicates (by sequence id) are dropped.
 */
export function decryptEvents(engine, { events = [], keyChangeEvents = [], signingKeys } = {}) {
    const { keys, skipped } = normalizeSigningKeys(signingKeys, engine);
    const inputs = [];
    const seen = new Set();
    for (const b64 of [...keyChangeEvents, ...events]) {
        if (typeof b64 !== 'string' || b64.length === 0) {
            continue;
        }
        let meta = null;
        let parseError = null;
        try {
            meta = rawMeta(b64);
        }
        catch (error) {
            parseError = `Malformed event: ${error.message}`;
        }
        const dedupeKey = meta?.sequenceId ? `seq:${meta.sequenceId}` : `b64:${b64}`;
        if (seen.has(dedupeKey)) {
            continue;
        }
        seen.add(dedupeKey);
        inputs.push({ b64, meta, parseError });
    }
    engine.setCacheKeys(true);
    engine.setSigningKeys(keys);
    const valid = inputs.filter((input) => !input.parseError);
    const result = valid.length > 0 ? engine.decryptEvents(valid.map((input) => input.b64), keys) : { messages: [], errors: {}, conversationKeys: { keys: {}, latestVersion: null } };
    const decrypted = new Map(result.messages.map((message) => [message.originalB64, message.event]));
    const errors = new Map(Object.entries(result.errors ?? {}).map(([index, message]) => [valid[Number(index)]?.b64, message]));
    const conversationKeys = result.conversationKeys?.keys ?? {};
    const context = {
        engine,
        conversationKeys,
        textBySequence: new Map(),
        keyFor(meta, keyVersion) {
            const key = conversationKeys[keyVersion];
            // contents_encryption_version 1: each message is encrypted under a key derived for it alone.
            return key && num(meta?.detail?.[112]) === 1 ? perMessageKey(key, meta.senderId, meta.messageId) : key;
        },
    };
    // Per-message-key messages fail the SDK's normal path; retry them with their derived key.
    for (const input of valid) {
        const { meta } = input;
        const version = text(meta.detail?.[101]);
        if (decrypted.has(input.b64) || meta.variant !== DETAIL.MESSAGE || num(meta.detail?.[112]) !== 1 || !conversationKeys[version]) {
            continue;
        }
        try {
            const key = perMessageKey(conversationKeys[version], meta.senderId, meta.messageId);
            decrypted.set(input.b64, engine.decryptEvent(input.b64, { [version]: key }, keys));
            errors.delete(input.b64);
        }
        catch (error) {
            errors.set(input.b64, error.message);
        }
    }
    // Pins name their target by sequence id; index message text so a pin can quote what it pinned.
    for (const event of decrypted.values()) {
        if (event?.type === 'message' && event.content?.contentType === 'text') {
            context.textBySequence.set(String(event.sequenceId), event.content.text ?? '');
        }
    }
    const rows = inputs.map(({ b64, meta, parseError }) => {
        if (parseError) {
            return errorRow(meta, parseError);
        }
        const event = decrypted.get(b64);
        return event ? rowFor(meta, event, context) : errorRow(meta, errors.get(b64) ?? 'Event was not returned by chat-xdk');
    });
    rows.sort((a, b) => numericFirst(a.sequenceId ?? '', b.sequenceId ?? ''));
    const unverifiedSenders = [...new Set(rows.filter((row) => row.status === 'unverified' && row.senderId).map((row) => row.senderId))];
    // Raw events stay addressable so replies, reactions and edits can hand chat-xdk their exact target.
    const raw = { bySequence: new Map(), byMessageId: new Map(), keyChanges: [] };
    for (const { b64, meta } of valid) {
        raw.bySequence.set(meta.sequenceId, b64);
        raw.byMessageId.set(meta.messageId, b64);
        if (meta.variant === DETAIL.KEY_CHANGE) {
            raw.keyChanges.push(b64);
        }
    }
    return {
        rows, unverifiedSenders, skippedSigningKeys: skipped, conversationKeys,
        latestKeyVersion: result.conversationKeys?.latestVersion ?? null, raw,
    };
}
