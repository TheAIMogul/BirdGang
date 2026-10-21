// ABOUTME: Encrypts images for X Chat upload and decrypts downloaded attachments under the conversation key.
// ABOUTME: Parts stay in memory (BirdGang uploads them itself); decrypted files are written 0600 in a 0700 dir.
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { chatWasm } from './engine.js';
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_PART_BYTES = 4 * 1024 * 1024;
const MIN_PART_BYTES = 64 * 1024;
const MAX_IMAGES = 10;
const SENDABLE = { 'image/png': 1, 'image/jpeg': 1, 'image/webp': 1, 'image/gif': 2 };
const EXTENSIONS = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/bmp': '.bmp', 'image/svg+xml': '.svg',
    'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/ogg': '.ogg',
    'application/pdf': '.pdf', 'application/zip': '.zip',
};
const mib = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
/**
 * Encrypt one image for upload. Returns the attachment fields the message needs plus the encrypted upload parts.
 * `key`/`keyVersion` must be the conversation key the message itself will be encrypted under.
 */
export async function encryptImage(engine, { bytes, filename, key, keyVersion, partBytes = MAX_PART_BYTES }) {
    const glue = await chatWasm();
    const mimeType = glue.detectMimeType(bytes);
    if (!SENDABLE[mimeType]) {
        throw new Error(`${filename}: only PNG, JPEG, GIF and WebP images can be sent`);
    }
    if (bytes.length > MAX_IMAGE_BYTES) {
        throw new Error(`${filename}: images are limited to 5 MiB (this one is ${mib(bytes.length)})`);
    }
    const dimensions = glue.detectImageDimensions(bytes);
    if (!dimensions) {
        throw new Error(`${filename}: could not read the image size`);
    }
    const encrypted = engine.encryptStream(bytes, key);
    const size = Math.min(MAX_PART_BYTES, Math.max(MIN_PART_BYTES, Math.floor(partBytes)));
    const parts = [];
    for (let at = 0; at < encrypted.length; at += size) {
        parts.push(encrypted.subarray(at, at + size));
    }
    return {
        filename, mimeType, width: dimensions.width, height: dimensions.height,
        mediaType: SENDABLE[mimeType], totalBytes: encrypted.length, keyVersion: String(keyVersion), parts,
    };
}
/** The chat-xdk attachment descriptor for an uploaded image (filesize is the encrypted size receivers download). */
export function imageAttachment(image, mediaHashKey) {
    return {
        attachment_type: 'media', media_hash_key: mediaHashKey, width: image.width, height: image.height,
        filesize_bytes: image.totalBytes, filename: image.filename, media_type: image.mediaType,
    };
}
export function assertImageCount(count) {
    if (count > MAX_IMAGES) {
        throw new Error(`At most ${MAX_IMAGES} images can be sent in one message`);
    }
}
/** Find the message row and attachment that carry a media hash key (attachments and link-card images). */
export function findMedia(rows, mediaHashKey) {
    for (const row of rows) {
        const attachment = row.attachments?.find((item) => item.mediaHashKey === mediaHashKey || item.bannerImageMediaHashKey === mediaHashKey);
        if (attachment) {
            return { row, attachment };
        }
    }
    return null;
}
export function defaultMediaDir() {
    return path.join(homedir(), '.cache', 'birdgang', 'xchat-media');
}
/**
 * Decrypt a downloaded attachment (unencrypted media is kept as downloaded) and write it privately.
 * Returns the written path and what was detected about the file.
 */
export async function saveDecryptedMedia(engine, { bytes, key, outDir = defaultMediaDir(), baseName, filename }) {
    const plaintext = key ? engine.decryptStream(bytes, key) : bytes;
    const glue = await chatWasm();
    const mimeType = glue.detectMimeType(plaintext) ?? 'application/octet-stream';
    mkdirSync(outDir, { recursive: true, mode: 0o700 });
    const safeName = (filename ? path.basename(filename) : `${baseName}${EXTENSIONS[mimeType] ?? '.bin'}`).replace(/[^\w.\- ]+/g, '_');
    const file = path.join(outDir, safeName);
    writeFileSync(file, plaintext, { mode: 0o600 });
    // `mode` only applies when the file is created; an overwritten file keeps its old permissions.
    chmodSync(file, 0o600);
    return { path: file, mimeType, sizeBytes: plaintext.length };
}
