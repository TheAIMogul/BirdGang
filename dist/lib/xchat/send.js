// ABOUTME: Builds signed, encrypted X Chat payloads with chat-xdk: messages, replies, reactions, edits, images.
// ABOUTME: Validates the request up front and refuses to mix conversation keys between an image and its message.
import { conversationIdForms } from './decode.js';
import { extractEntities, toSdkEntities } from './entities.js';
import { assertImageCount, imageAttachment } from './media.js';
/** The raw event for a sequence id or message id among the fetched events. */
export function findTarget(decoded, ref) {
    const key = String(ref ?? '').trim();
    const b64 = decoded.raw.bySequence.get(key) ?? decoded.raw.byMessageId.get(key);
    if (!b64) {
        throw new Error(`Message ${key} is not in the fetched conversation; fetch more history or check the id`);
    }
    const row = decoded.rows.find((item) => item.sequenceId === key || item.messageId === key);
    return { b64, sequenceId: row?.sequenceId ?? key };
}
function validate(request) {
    const actions = ['replyTo', 'react', 'edit'].filter((name) => request[name] !== undefined && request[name] !== null);
    if (actions.length > 1) {
        throw new Error('Use only one of reply, react or edit');
    }
    const text = request.text ?? '';
    const images = request.images ?? [];
    assertImageCount(images.length);
    if (request.react) {
        if (!request.react.emoji) {
            throw new Error('A reaction needs an emoji');
        }
        if (text || images.length > 0 || request.ttlMsec) {
            throw new Error('A reaction carries no text, images or disappearing timer');
        }
    }
    else if (request.edit) {
        if (!text) {
            throw new Error('An edit needs the new text');
        }
        if (images.length > 0 || request.ttlMsec) {
            throw new Error('An edit can only change the text');
        }
    }
    else if (!text && images.length === 0) {
        throw new Error('Nothing to send: give text or an image');
    }
    return actions[0] ?? 'message';
}
/**
 * Encrypt and sign one outgoing action. `decoded` is decryptEvents() output for the conversation (it warms the
 * verified conversation key and holds reply/react/edit targets). `conversationKey` ({ key, version }) is only for
 * first contact, when no key change has been sent yet.
 */
export function prepareSend(engine, decoded, request) {
    const kind = validate(request);
    const ids = conversationIdForms(request.conversationId);
    const text = request.text ?? '';
    const entities = text ? toSdkEntities(extractEntities(text)) : undefined;
    const explicitKey = request.conversationKey
        ? { conversationKey: request.conversationKey.key, conversationKeyVersion: String(request.conversationKey.version) }
        : {};
    const options = {
        ...(request.ttlMsec ? { ttlMsec: Number(request.ttlMsec) } : {}),
        ...(request.notify === false ? { shouldNotify: false } : {}),
    };
    const images = request.images ?? [];
    const attachments = images.length > 0 ? images.map((image) => imageAttachment(image, image.mediaHashKey)) : undefined;
    let action = kind;
    let target;
    let payload;
    if (kind === 'react') {
        target = findTarget(decoded, request.react.target);
        const params = { emoji: request.react.emoji, targetEvent: target.b64 };
        payload = request.react.remove ? engine.encryptRemoveReaction(params) : engine.encryptAddReaction(params);
        action = request.react.remove ? 'reaction_removed' : 'reaction';
    }
    else if (kind === 'edit') {
        target = findTarget(decoded, request.edit);
        payload = engine.encryptEdit({ updatedText: text, entities, targetEvent: target.b64 });
    }
    else if (kind === 'replyTo') {
        target = findTarget(decoded, request.replyTo);
        action = 'reply';
        payload = engine.encryptReply({
            conversationId: ids.colon, text, entities, attachments, replyToEvent: target.b64,
            replyToCkces: decoded.raw.keyChanges, ...explicitKey, ...options,
        });
    }
    else {
        payload = engine.encryptMessage({ conversationId: ids.colon, text, entities, attachments, ...explicitKey, ...options });
    }
    for (const image of images) {
        if (image.keyVersion !== payload.conversationKeyVersion) {
            throw new Error(`${image.filename} was encrypted under conversation key ${image.keyVersion}, but the conversation now uses ${payload.conversationKeyVersion}; send it again`);
        }
    }
    return {
        action, targetSequenceId: target?.sequenceId ?? null, conversationId: ids.hyphen, uploadConversationId: ids.colon, payload,
    };
}
/** First contact: a fresh conversation key wrapped for every participant, plus its signed key-change actions. */
export function prepareFirstContact(engine, { conversationId, publicKeys }) {
    const ids = conversationIdForms(conversationId);
    const change = engine.prepareConversationKeyChange({
        publicKeys: publicKeys.map((entry) => ({ userId: String(entry.userId), publicKey: entry.identityPublicKey, keyVersion: String(entry.publicKeyVersion) })),
        ...(ids.participants.length === 2 ? {} : { conversationId: ids.colon }),
    });
    return { change, conversationKey: { key: change.conversationKey, version: change.conversationKeyVersion } };
}
