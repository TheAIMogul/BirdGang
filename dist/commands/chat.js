// birdgang chat — read and write X Chat (encrypted DMs) over the web chat transport.
// unlock/inbox/read never write to X; send/reply/react/edit/dl send real messages and media.
import { readFileSync } from 'node:fs';
import { TwitterClient } from '../lib/twitter-client.js';
import { conversationIdForms, decryptEvents } from '../lib/xchat/decode.js';
import { encryptImage, findMedia, saveDecryptedMedia } from '../lib/xchat/media.js';
import { forgetKey } from '../lib/xchat/keystore.js';
import { prepareFirstContact, prepareSend } from '../lib/xchat/send.js';
import { unlock } from '../lib/xchat/session.js';
import { createXChatTransport } from '../lib/xchat/transport.js';

const fail = (ctx, message) => {
    console.error(`${ctx.p('err')}${message}`);
    process.exit(1);
};
const jsonOut = (value) => console.log(JSON.stringify(value, null, 2));
const shortTime = (iso) => {
    if (!iso) {
        return '';
    }
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : date.toISOString().replace('T', ' ').slice(0, 16) + 'Z';
};
async function makeClient(ctx, opts) {
    const timeoutMs = ctx.resolveTimeoutFromOptions(opts);
    const { cookies, warnings } = await ctx.resolveCredentialsFromOptions(opts);
    for (const warning of warnings) {
        console.error(`${ctx.p('warn')}${warning}`);
    }
    if (!cookies.authToken || !cookies.ct0) {
        fail(ctx, 'Missing required credentials');
    }
    if (cookies.source) {
        console.error(`${ctx.l('source')}${cookies.source}`);
    }
    return new TwitterClient({ cookies, timeoutMs });
}
/** Credentials + transport + unlocked engine, in one shot. Juicebox tokens are fetched here, right before unlock. */
async function openChat(ctx, opts, { remember = false, forcePin = false } = {}) {
    const client = await makeClient(ctx, opts);
    try {
        await client.ensureClientUserId();
    }
    catch (error) {
        fail(ctx, `Could not resolve the signed-in account: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!client.clientUserId) {
        fail(ctx, 'Could not resolve the signed-in X account; check your cookies');
    }
    const transport = createXChatTransport({ client });
    let ownKeys;
    try {
        ownKeys = await transport.getOwnKeyRecord({ userId: client.clientUserId });
    }
    catch (error) {
        fail(ctx, error instanceof Error ? error.message : String(error));
    }
    if (ownKeys.unavailable) {
        fail(ctx, `This X account has no X Chat keys yet (${ownKeys.reason}); set up encrypted messages in the X app first`);
    }
    let session;
    try {
        session = await unlock({
            userId: client.clientUserId,
            ownKeys: {
                publicKeyVersion: ownKeys.latest.public_key_version,
                identityPublicKey: ownKeys.latest.public_key,
                juiceboxConfig: ownKeys.latest.juicebox_config,
            },
            remember,
            forcePin,
        });
    }
    catch (error) {
        fail(ctx, error instanceof Error ? error.message : String(error));
    }
    return { client, transport, engine: session.engine, session, userId: client.clientUserId, ownKeys };
}
/** All signing-key entries the CLI holds: the account's own plus every participant's inline keys. */
function signingKeyEntries(conversations, ownKeys) {
    const entries = [];
    for (const conversation of conversations) {
        for (const participant of conversation.participants) {
            entries.push(...(participant.keys ?? []));
        }
    }
    if (ownKeys?.latest) {
        const { user_id, public_key_version, public_key, signing_public_key, identity_public_key_signature } = ownKeys.latest;
        entries.push({ user_id, public_key_version, public_key, signing_public_key, identity_public_key_signature });
    }
    return entries;
}
/** Decrypt a conversation, then fetch any still-unverified senders' keys in one batch and decrypt again. */
async function decryptConversation(transport, engine, conversation, signingKeys) {
    const decode = (keys) => decryptEvents(engine, {
        events: conversation.events,
        keyChangeEvents: conversation.keyChangeEvents,
        signingKeys: keys,
    });
    let decoded = decode(signingKeys);
    if (decoded.unverifiedSenders.length > 0) {
        const records = await transport.getPublicKeys(decoded.unverifiedSenders);
        const fetched = records.flatMap((record) => (record.unavailable ? [] : record.keys));
        if (fetched.length > 0) {
            decoded = decode([...signingKeys, ...fetched]);
            conversation.participants.push(...records
                .filter((record) => !record.unavailable)
                .map((record) => ({ id: record.userId, name: null, screenName: null, keys: record.keys })));
        }
    }
    return decoded;
}
function conversationLabel(conversation, ownId) {
    const others = conversation.participants.filter((participant) => participant.id !== String(ownId));
    if (conversation.isGroup) {
        return `${others.length + 1}-person group`;
    }
    if (others.length === 0) {
        return 'Yourself (self-chat)';
    }
    const other = others[0];
    return other.screenName ? `@${other.screenName}` : (other.name ?? other.id);
}
function namesBySender(conversations, ownId) {
    const names = new Map();
    for (const conversation of conversations) {
        for (const participant of conversation.participants) {
            if (participant.id) {
                names.set(participant.id, participant.screenName ? `@${participant.screenName}` : participant.id);
            }
        }
    }
    names.set(String(ownId), 'you');
    return names;
}
function renderRow(ctx, row, names) {
    const who = names.get(String(row.senderId)) ?? row.senderId ?? '?';
    const mark = row.status === 'unverified' ? ' [unverified]' : row.status === 'unencrypted' ? ' [unencrypted]' : '';
    const parts = [`${ctx.colors.muted(shortTime(row.createdAt))} ${who}${mark}:`];
    const body = row.notice ?? row.text ?? '';
    parts.push(body || '[empty]');
    if (row.attachments?.length) {
        parts.push(row.attachments.map((attachment) => `[media ${attachment.mediaHashKey}]`).join(' '));
    }
    if (row.replyTo) {
        parts.push(`↩ reply to ${row.replyTo.sequenceId ?? row.replyTo.messageId ?? '?'}`);
    }
    return parts.filter(Boolean).join(' ');
}
/** The conversation from the inbox, by id (either colon or hyphen form works). */
function findConversation(inbox, conversationId) {
    const wanted = conversationIdForms(conversationId).colon;
    return inbox.conversations.find((conversation) => conversationIdForms(conversation.conversationId).colon === wanted) ?? null;
}
async function loadInbox(transport, limit) {
    try {
        return await transport.getInbox({ limit });
    }
    catch (error) {
        throw new Error(`Could not list your conversations: ${error instanceof Error ? error.message : String(error)}`);
    }
}
/** A conversation's history merged over its inbox snapshot, plus the merged decode. */
async function readConversation(transport, engine, conversation, inbox, { historyLimit = 100, signingKeys = [] } = {}) {
    const merged = {
        ...conversation,
        events: [...conversation.events],
        keyChangeEvents: [...conversation.keyChangeEvents],
    };
    if (historyLimit > 0) {
        const history = await transport.getConversationEvents({
            conversationId: conversation.conversationId,
            maxSequenceId: inbox.maxUserSequenceId,
            limit: historyLimit,
        });
        merged.events = [...history.events, ...merged.events];
        merged.keyChangeEvents = [...history.keyChangeEvents, ...merged.keyChangeEvents];
    }
    const decoded = await decryptConversation(transport, engine, merged, signingKeys);
    return { conversation: merged, decoded };
}
function ownSigningPublicKey(engine) {
    const keys = engine.getPublicKeys?.();
    return keys?.publicKey?.signingPublicKey ?? keys?.signingPublicKey ?? null;
}
/**
 * One outgoing action (message / reply / react / edit), shared by chat send/reply/react/edit.
 * `request` mirrors prepareSend()'s: { text, replyTo?, react?, edit?, ttlMsec?, notify?, mediaPaths? }.
 */
async function runSend(ctx, opts, cmdOpts, request) {
    const { client, transport, engine, ownKeys, userId } = await openChat(ctx, opts);
    const raw = String(cmdOpts.conversation).trim();
    let targetUserId = null;
    let conversationId = null;
    if (raw.startsWith('@')) {
        const lookedUp = await client.getUserIdByUsername(raw.replace(/^@/, ''));
        if (!lookedUp.success || !lookedUp.userId) {
            fail(ctx, `Could not resolve ${raw}: ${lookedUp.error ?? 'unknown error'}`);
        }
        targetUserId = lookedUp.userId;
    }
    else {
        conversationId = conversationIdForms(raw).colon;
    }
    const inbox = await loadInbox(transport, 200);
    const signingKeys = signingKeyEntries(inbox.conversations, ownKeys);
    let conversation = conversationId ? findConversation(inbox, conversationId) : null;
    // @handle with an existing 1:1 conversation resumes it; only a truly new chat runs first contact.
    if (!conversation && targetUserId) {
        conversation = inbox.conversations.find((item) => !item.isGroup && conversationIdForms(item.conversationId).participants.includes(String(targetUserId))) ?? null;
    }
    if (!conversation && !targetUserId) {
        // An explicit id that is not in the inbox cannot be started from here; suggest the handle.
        const forms = conversationIdForms(conversationId);
        fail(ctx, forms.participants.length === 2
            ? `Conversation ${conversationId} is not in your inbox; send to @handle to start a new one`
            : `Conversation ${conversationId} is not in your inbox`);
    }
    let decoded;
    let conversationKey = null;
    if (conversation) {
        const needHistory = Boolean(request.replyTo || request.react || request.edit);
        const read = await readConversation(transport, engine, conversation, inbox, {
            historyLimit: needHistory ? 200 : 0,
            signingKeys,
        });
        conversation = read.conversation;
        decoded = read.decoded;
        conversationId = conversationIdForms(conversation.conversationId).colon;
        // The inbox snapshot can miss older key-change events; pull history once if no key warmed up.
        if (!decoded.latestKeyVersion) {
            const deeper = await readConversation(transport, engine, conversation, inbox, { historyLimit: 200, signingKeys });
            conversation = deeper.conversation;
            decoded = deeper.decoded;
        }
    }
    else {
        // First contact with @handle: wrap a fresh conversation key for both participants, POST it,
        // then encrypt the message under it (handover §4's prepareFirstContact flow).
        const records = await transport.getPublicKeys([targetUserId]);
        const other = records.find((record) => !record.unavailable);
        if (!other || other.unavailable || !other.hasPublicKey) {
            fail(ctx, `@${raw.slice(1)} has no X Chat key; they must set up encrypted messages first`);
        }
        // conversationIdForms sorts the two ids numerically as strings (ids exceed 2^53).
        const ids = conversationIdForms(`${userId}:${targetUserId}`);
        const first = prepareFirstContact(engine, {
            conversationId: ids.colon,
            publicKeys: [
                { userId: String(userId), identityPublicKey: ownKeys.latest.public_key, publicKeyVersion: ownKeys.latest.public_key_version },
                ...other.keys.map((key) => ({ userId: other.userId, identityPublicKey: key.public_key, publicKeyVersion: key.public_key_version })),
            ],
        });
        try {
            await transport.addConversationKeys({
                conversationId: ids.colon,
                change: first.change,
                signingPublicKey: ownSigningPublicKey(engine),
                ...(request.ttlMsec ? { ttlMsec: request.ttlMsec } : {}),
            });
        }
        catch (error) {
            fail(ctx, `Could not start the conversation: ${error instanceof Error ? error.message : String(error)}`);
        }
        conversation = { conversationId: ids.colon, isGroup: false, isArchived: false, isMuted: false, messageTtlMsec: null, participants: [], events: [], keyChangeEvents: [] };
        conversationId = ids.colon;
        conversationKey = first.conversationKey;
        decoded = decryptEvents(engine, { events: [], keyChangeEvents: [], signingKeys: [ownKeys.latest, ...other.keys] });
    }
    // Attachments are encrypted under the very key the message will use, uploaded, then referenced.
    const images = [];
    if (request.mediaPaths?.length) {
        const key = conversationKey
            ? conversationKey.key
            : decoded.conversationKeys[String(decoded.latestKeyVersion)];
        const keyVersion = conversationKey ? String(conversationKey.version) : String(decoded.latestKeyVersion);
        if (!key) {
            fail(ctx, 'No conversation key is available yet, so media cannot be attached; send a text message first');
        }
        for (const mediaPath of request.mediaPaths) {
            let bytes;
            try {
                bytes = readFileSync(mediaPath);
            }
            catch (error) {
                fail(ctx, `Could not read ${mediaPath}: ${error instanceof Error ? error.message : String(error)}`);
            }
            let image;
            try {
                image = await encryptImage(engine, { bytes, filename: mediaPath.split('/').pop() ?? mediaPath, key, keyVersion });
            }
            catch (error) {
                fail(ctx, error instanceof Error ? error.message : String(error));
            }
            let uploaded;
            try {
                uploaded = await transport.uploadMedia({ conversationId, bytes: Buffer.concat(image.parts.map((part) => Buffer.from(part))), contentType: image.mimeType });
            }
            catch (error) {
                fail(ctx, `Media upload failed: ${error instanceof Error ? error.message : String(error)}`);
            }
            console.error(`${ctx.p('info')}uploaded ${image.filename} (${uploaded.numParts} part${uploaded.numParts === 1 ? '' : 's'})`);
            images.push({ ...image, mediaHashKey: uploaded.mediaHashKey });
        }
    }
    let out;
    try {
        out = prepareSend(engine, decoded, {
            conversationId,
            text: request.text,
            ...(request.replyTo ? { replyTo: request.replyTo } : {}),
            ...(request.react ? { react: request.react } : {}),
            ...(request.edit ? { edit: request.edit } : {}),
            ...(images.length ? { images } : {}),
            ...(request.ttlMsec ? { ttlMsec: request.ttlMsec } : {}),
            ...(request.notify === false ? { notify: false } : {}),
            ...(conversationKey ? { conversationKey } : {}),
        });
    }
    catch (error) {
        fail(ctx, error instanceof Error ? error.message : String(error));
    }
    try {
        await transport.sendMessageCreate({ conversationId, payload: out.payload });
    }
    catch (error) {
        fail(ctx, error instanceof Error ? error.message : String(error));
    }
    if (cmdOpts.json) {
        jsonOut({
            sent: true, action: out.action, conversationId, messageId: out.payload.messageId,
            targetSequenceId: out.targetSequenceId, keyVersion: out.payload.conversationKeyVersion,
        });
    }
    else {
        const target = out.targetSequenceId ? ` (to ${out.targetSequenceId})` : '';
        console.log(`${ctx.p('ok')}${out.action} sent${target}`);
    }
}

export function registerChatCommands(program, ctx) {
    const chat = program
        .command('chat')
        .description('Read and write X Chat (encrypted DMs): unlock, inbox, read, send, reply, react, edit, dl');
    chat
        .command('unlock')
        .description('Unlock your X Chat identity key (PIN once, then it can be remembered)')
        .option('--remember', 'Store the identity key so later runs need no PIN')
        .option('--pin', 'Ask for the PIN even if a key is already remembered')
        .option('--json', 'Output JSON')
        .action(async (cmdOpts) => {
        const opts = program.opts();
        const { session, ownKeys, userId } = await openChat(ctx, opts, {
            remember: Boolean(cmdOpts.remember),
            forcePin: Boolean(cmdOpts.pin),
        });
        if (cmdOpts.json) {
            jsonOut({
                unlocked: true,
                userId,
                keyVersion: session.keyVersion,
                keySource: session.keySource,
                savedTo: session.savedTo,
                registrationMethod: ownKeys.registrationMethod,
                managedPin: ownKeys.isManagedPinUser,
            });
            return;
        }
        console.log(`${ctx.p('ok')}X Chat unlocked (key version ${session.keyVersion}, from ${session.keySource})`);
        if (session.savedTo) {
            console.log(`${ctx.p('ok')}Key remembered in ${session.savedTo}; later runs will not need the PIN`);
        }
        else if (cmdOpts.remember) {
            console.log(`${ctx.p('warn')}The key was not stored; run again with --remember`);
        }
    });
    chat
        .command('forget')
        .description('Forget the remembered X Chat identity key for this account')
        .option('--json', 'Output JSON')
        .action(async (cmdOpts) => {
        const opts = program.opts();
        const client = await makeClient(ctx, opts);
        try {
            await client.ensureClientUserId();
        }
        catch (error) {
            fail(ctx, `Could not resolve the signed-in account: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (!client.clientUserId) {
            fail(ctx, 'Could not resolve the signed-in X account; check your cookies');
        }
        const removed = forgetKey({ userId: client.clientUserId });
        if (cmdOpts.json) {
            jsonOut({ userId: client.clientUserId, removedFrom: removed });
            return;
        }
        if (removed.length === 0) {
            console.log('No remembered X Chat key for this account.');
        }
        else {
            console.log(`${ctx.p('ok')}Forgot the X Chat key (${removed.join(', ')})`);
        }
    });
    chat
        .command('inbox')
        .description('List your X Chat conversations with the latest decrypted message')
        .option('--limit <n>', 'How many conversations to list', '20')
        .option('--json', 'Output JSON')
        .action(async (cmdOpts) => {
        const opts = program.opts();
        const { transport, engine, ownKeys, userId } = await openChat(ctx, opts);
        const limit = Math.max(1, Number.parseInt(cmdOpts.limit, 10) || 20);
        const inbox = await loadInbox(transport, limit);
        const signingKeys = signingKeyEntries(inbox.conversations, ownKeys);
        const entries = [];
        for (const conversation of inbox.conversations) {
            const decoded = await decryptConversation(transport, engine, conversation, signingKeys);
            const last = [...decoded.rows].reverse().find((row) => (row.notice ?? row.text) !== '' && row.notice !== '[event could not be read]');
            entries.push({ conversation, decoded, last: last ?? null });
        }
        if (cmdOpts.json) {
            jsonOut({
                conversations: entries.map(({ conversation, last }) => ({
                    conversationId: conversation.conversationId,
                    isGroup: conversation.isGroup,
                    isArchived: conversation.isArchived,
                    isMuted: conversation.isMuted,
                    ttlMsec: conversation.messageTtlMsec,
                    participants: conversation.participants.map((participant) => ({ id: participant.id, screenName: participant.screenName })),
                    latest: last
                        ? { sequenceId: last.sequenceId, senderId: last.senderId, text: last.notice ?? last.text, status: last.status, createdAt: last.createdAt }
                        : null,
                })),
            });
            return;
        }
        if (entries.length === 0) {
            console.log('No conversations found.');
            return;
        }
        for (const { conversation, last } of entries) {
            const label = conversationLabel(conversation, userId);
            const text = last ? `${last.notice ?? last.text}`.split('\n')[0].slice(0, 80) : '[no messages]';
            const when = last ? shortTime(last.createdAt) : '';
            console.log(`${ctx.colors.command(conversation.conversationId)}  ${ctx.colors.muted(label)}`);
            console.log(`  ${ctx.colors.muted(when)} ${text}`);
        }
    });
    chat
        .command('read')
        .description('Print a conversation, oldest first, with verification status')
        .argument('<conversation>', 'Conversation id (a:b, a-b, or g…); @handle for your chat with that user')
        .option('--limit <n>', 'How many events back to fetch', '100')
        .option('--json', 'Output JSON')
        .action(async (conversationArg, cmdOpts) => {
        const opts = program.opts();
        const { client, transport, engine, ownKeys, userId } = await openChat(ctx, opts);
        const inbox = await loadInbox(transport, 200);
        const signingKeys = signingKeyEntries(inbox.conversations, ownKeys);
        let conversation;
        if (String(conversationArg).trim().startsWith('@')) {
            const handle = String(conversationArg).trim();
            const lookedUp = await client.getUserIdByUsername(handle.replace(/^@/, ''));
            if (!lookedUp.success || !lookedUp.userId) {
                fail(ctx, `Could not resolve ${handle}: ${lookedUp.error ?? 'unknown error'}`);
            }
            conversation = inbox.conversations.find((item) => conversationIdForms(item.conversationId).participants.includes(String(lookedUp.userId))) ?? null;
        }
        else {
            conversation = findConversation(inbox, conversationArg);
        }
        if (!conversation) {
            fail(ctx, `Conversation ${conversationArg} is not in your inbox (run ${ctx.colors.command('birdgang chat inbox')} to list them)`);
        }
        const limit = Math.max(1, Number.parseInt(cmdOpts.limit, 10) || 100);
        const { decoded } = await readConversation(transport, engine, conversation, inbox, { historyLimit: limit, signingKeys });
        if (cmdOpts.json) {
            const names = namesBySender([conversation], userId);
            jsonOut({
                conversationId: conversation.conversationId,
                senders: Object.fromEntries([...names].map(([id, name]) => [id, name])),
                rows: decoded.rows,
                unverifiedSenders: decoded.unverifiedSenders,
                truncated: decoded.rows.length >= limit,
            });
            return;
        }
        const names = namesBySender([conversation], userId);
        for (const row of decoded.rows) {
            console.log(renderRow(ctx, row, names));
        }
    });
    chat
        .command('send')
        .description('Send an encrypted message (use --media to attach images, --ttl for disappearing)')
        .argument('<conversation>', 'Conversation id (a:b, a-b, g…) or @handle to start a new chat')
        .argument('<text...>', 'Message text')
        .option('--ttl <seconds>', 'Disappearing-messages timer in seconds')
        .option('--no-notify', 'Send without notifying the recipient')
        .option('--json', 'Output JSON')
        .action(async (conversationArg, textParts, cmdOpts) => {
        const opts = program.opts();
        const ttlMsec = cmdOpts.ttl ? Math.round(Number(cmdOpts.ttl) * 1000) : null;
        if (cmdOpts.ttl && (!Number.isFinite(ttlMsec) || ttlMsec <= 0)) {
            fail(ctx, `Invalid --ttl "${cmdOpts.ttl}" (seconds, e.g. 60)`);
        }
        await runSend(ctx, opts, { ...cmdOpts, conversation: conversationArg }, {
            text: textParts.join(' '),
            mediaPaths: opts.media ?? [],
            ...(ttlMsec ? { ttlMsec } : {}),
            ...(cmdOpts.notify === false ? { notify: false } : {}),
        });
    });
    chat
        .command('reply')
        .description('Reply to a message (by its sequence id or message id)')
        .argument('<conversation>', 'Conversation id (a:b, a-b, g…) or @handle to start a new chat')
        .argument('<target>', 'Sequence id or message id of the message to reply to')
        .argument('<text...>', 'Reply text')
        .option('--json', 'Output JSON')
        .action(async (conversationArg, target, textParts, cmdOpts) => {
        const opts = program.opts();
        await runSend(ctx, opts, { ...cmdOpts, conversation: conversationArg }, {
            text: textParts.join(' '),
            replyTo: target,
        });
    });
    chat
        .command('react')
        .description('React to a message (by its sequence id or message id)')
        .argument('<conversation>', 'Conversation id (a:b, a-b, g…)')
        .argument('<emoji>', 'The reaction emoji')
        .argument('<target>', 'Sequence id or message id of the message to react to')
        .option('--remove', 'Remove the reaction instead')
        .option('--json', 'Output JSON')
        .action(async (conversationArg, emoji, target, cmdOpts) => {
        const opts = program.opts();
        await runSend(ctx, opts, { ...cmdOpts, conversation: conversationArg }, {
            text: '',
            react: { emoji, target, remove: Boolean(cmdOpts.remove) },
        });
    });
    chat
        .command('edit')
        .description('Edit a message you sent (by its sequence id or message id)')
        .argument('<conversation>', 'Conversation id (a:b, a-b, g…)')
        .argument('<target>', 'Sequence id or message id of the message to edit')
        .argument('<text...>', 'Replacement text')
        .option('--json', 'Output JSON')
        .action(async (conversationArg, target, textParts, cmdOpts) => {
        const opts = program.opts();
        await runSend(ctx, opts, { ...cmdOpts, conversation: conversationArg }, {
            text: textParts.join(' '),
            edit: target,
        });
    });
    chat
        .command('dl')
        .description('Download and decrypt a conversation attachment (mode 0600)')
        .argument('<conversation>', 'Conversation id (a:b, a-b, g…)')
        .argument('<media-hash-key>', 'The attachment media hash key (shown by chat read)')
        .option('-o, --out <dir>', 'Output directory', undefined)
        .option('--json', 'Output JSON')
        .action(async (conversationArg, mediaHashKey, cmdOpts) => {
        const opts = program.opts();
        const { transport, engine, ownKeys, userId } = await openChat(ctx, opts);
        const inbox = await loadInbox(transport, 200);
        const conversation = findConversation(inbox, conversationArg);
        if (!conversation) {
            fail(ctx, `Conversation ${conversationArg} is not in your inbox (run ${ctx.colors.command('birdgang chat inbox')} to list them)`);
        }
        const signingKeys = signingKeyEntries(inbox.conversations, ownKeys);
        const { decoded } = await readConversation(transport, engine, conversation, inbox, { historyLimit: 500, signingKeys });
        const found = findMedia(decoded.rows, mediaHashKey);
        if (!found) {
            fail(ctx, `Media ${mediaHashKey} was not found in the fetched history; try chat read --limit 500`);
        }
        const key = decoded.conversationKeys[found.attachment.keyVersion];
        if (!key) {
            fail(ctx, `The conversation key for this attachment (version ${found.attachment.keyVersion}) is not in the fetched history`);
        }
        let bytes;
        try {
            bytes = await transport.downloadMedia({ conversationId: conversation.conversationId, mediaHashKey });
        }
        catch (error) {
            fail(ctx, error instanceof Error ? error.message : String(error));
        }
        const saved = await saveDecryptedMedia(engine, {
            bytes,
            key,
            ...(cmdOpts.out ? { outDir: cmdOpts.out } : {}),
            baseName: String(mediaHashKey).slice(0, 12),
            ...(found.attachment.filename ? { filename: found.attachment.filename } : {}),
        });
        if (cmdOpts.json) {
            jsonOut({ ...saved, conversationId: conversation.conversationId, mediaHashKey, keyVersion: found.attachment.keyVersion });
            return;
        }
        console.log(`${ctx.p('ok')}${saved.path} (${saved.mimeType}, ${saved.sizeBytes} bytes, mode 0600)`);
    });
    return chat;
}
