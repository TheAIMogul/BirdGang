// ABOUTME: Remembers an unlocked X Chat identity key per X account so later runs skip the PIN.
// ABOUTME: macOS Keychain, Linux Secret Service, else a 0600 file; secrets go over stdin, never argv.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
const SERVICE = 'birdgang-xchat';
const LABEL = 'BirdGang X Chat key';
const RECORD_FORMAT = 'birdgang-xchat-key/1';
const FILE_FORMAT = 'birdgang-xchat-keys/1';
const KEY_BYTES = 64;
export const KEY_STORES = ['keychain', 'secret-service', 'file', 'none'];
function run(command, args, input) {
    return execFileSync(command, args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 15_000 });
}
function available(command, args) {
    try {
        run(command, args);
        return true;
    }
    catch (error) {
        return error.code !== 'ENOENT';
    }
}
/** The store to use: BIRDGANG_XCHAT_KEYSTORE wins, else the platform's best available. */
export function resolveKeyStore(preferred = process.env.BIRDGANG_XCHAT_KEYSTORE) {
    if (preferred) {
        if (!KEY_STORES.includes(preferred)) {
            throw new Error(`Unknown key store "${preferred}" (use ${KEY_STORES.join(', ')})`);
        }
        return preferred;
    }
    if (process.platform === 'darwin' && available('security', ['list-keychains'])) {
        return 'keychain';
    }
    if (process.platform === 'linux' && process.env.DBUS_SESSION_BUS_ADDRESS && available('secret-tool', ['--version'])) {
        return 'secret-service';
    }
    return 'file';
}
function keyDir(options) {
    return options.dir ?? path.join(homedir(), '.config', 'bird', 'xchat');
}
function readKeyFile(options) {
    try {
        const parsed = JSON.parse(readFileSync(path.join(keyDir(options), 'keys.json'), 'utf8'));
        return parsed?.format === FILE_FORMAT && parsed.keys && typeof parsed.keys === 'object' ? parsed : null;
    }
    catch {
        return null;
    }
}
function writeKeyFile(options, file) {
    const dir = keyDir(options);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = path.join(dir, 'keys.json');
    const temp = `${target}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, target);
}
const encode = (record) => Buffer.from(JSON.stringify(record)).toString('base64');
function decode(payload, userId) {
    try {
        const record = JSON.parse(Buffer.from(payload.trim(), 'base64').toString('utf8'));
        const secret = Buffer.from(record.key ?? '', 'base64');
        if (record.format !== RECORD_FORMAT || record.userId !== userId || secret.length !== KEY_BYTES) {
            secret.fill(0);
            return null;
        }
        return { keyVersion: String(record.keyVersion), secret };
    }
    catch {
        return null;
    }
}
const BACKENDS = {
    keychain: {
        // `security -i` reads its command from stdin, keeping the secret out of the process table.
        save: (userId, payload) => run('security', ['-i'], `add-generic-password -U -s ${SERVICE} -a ${userId} -l "${LABEL}" -w ${payload}\n`),
        load: (userId) => run('security', ['find-generic-password', '-s', SERVICE, '-a', userId, '-w']),
        remove: (userId) => run('security', ['delete-generic-password', '-s', SERVICE, '-a', userId]),
    },
    'secret-service': {
        save: (userId, payload) => run('secret-tool', ['store', `--label=${LABEL}`, 'service', SERVICE, 'account', userId], payload),
        load: (userId) => run('secret-tool', ['lookup', 'service', SERVICE, 'account', userId]),
        remove: (userId) => run('secret-tool', ['clear', 'service', SERVICE, 'account', userId]),
    },
};
function assertUserId(userId) {
    if (!/^\d+$/.test(String(userId ?? ''))) {
        throw new Error('A numeric X user id is required for the key store');
    }
    return String(userId);
}
/** Save the 64-byte identity‖signing secret; returns the store used. */
export function saveKey({ userId, keyVersion, secret }, options = {}) {
    const account = assertUserId(userId);
    const store = options.store ?? resolveKeyStore();
    if (store === 'none') {
        return store;
    }
    const record = { format: RECORD_FORMAT, userId: account, keyVersion: String(keyVersion), key: Buffer.from(secret).toString('base64') };
    if (store === 'file') {
        const file = readKeyFile(options) ?? { format: FILE_FORMAT, keys: {} };
        file.keys[account] = { ...record, savedAt: new Date().toISOString() };
        writeKeyFile(options, file);
    }
    else {
        BACKENDS[store].save(account, encode(record));
    }
    return store;
}
/** The remembered secret for this account, or null. The caller zeroes `secret`. */
export function loadKey({ userId }, options = {}) {
    const account = assertUserId(userId);
    const store = options.store ?? resolveKeyStore();
    if (store === 'none') {
        return null;
    }
    if (store === 'file') {
        const record = readKeyFile(options)?.keys?.[account];
        const found = record ? decode(encode(record), account) : null;
        return found ? { ...found, store } : null;
    }
    try {
        const found = decode(BACKENDS[store].load(account), account);
        return found ? { ...found, store } : null;
    }
    catch {
        return null;
    }
}
/** Delete this account's key from every store that holds it; returns the stores it was removed from. */
export function forgetKey({ userId }, options = {}) {
    const account = assertUserId(userId);
    const removed = [];
    const file = readKeyFile(options);
    if (file?.keys?.[account]) {
        delete file.keys[account];
        if (Object.keys(file.keys).length > 0) {
            writeKeyFile(options, file);
        }
        else {
            rmSync(path.join(keyDir(options), 'keys.json'), { force: true });
        }
        removed.push('file');
    }
    const native = options.store && options.store !== 'file' ? options.store : resolveKeyStore();
    if (BACKENDS[native]) {
        try {
            BACKENDS[native].remove(account);
            removed.push(native);
        }
        catch {
            // nothing stored there
        }
    }
    return removed;
}
