// ABOUTME: Lazily loads X's chat-xdk WASM engine and the Juicebox SDK, each exactly once per process.
// ABOUTME: Only chat commands import this, so other commands never load the ~4 MB of WebAssembly.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const RECOVER_REASONS = ['InvalidPin', 'NotRegistered', 'InvalidAuth', 'UpgradeRequired', 'RateLimitExceeded', 'Assertion', 'Transient'];
let wasmPromise;
let juiceboxPromise;
function once(load, reset) {
    return load().catch((error) => {
        reset();
        throw error;
    });
}
// The public entry withholds raw key import/export, which remember-key needs. Importing its WASM glue
// by file URL yields the very module instance the entry uses, so there is still one engine per process.
async function loadWasm() {
    const pkgDir = path.join(path.dirname(require.resolve('@xdevplatform/chat-xdk')), 'pkg');
    const glue = await import(pathToFileURL(path.join(pkgDir, 'chat_xdk_wasm.js')).href);
    await glue.default({ module_or_path: readFileSync(path.join(pkgDir, 'chat_xdk_wasm_bg.wasm')) });
    return glue;
}
// juicebox-sdk's glue caches views of a single WASM memory; a second instance (e.g. a plain
// `import 'juicebox-sdk'`) corrupts the first, so it is instantiated here and nowhere else.
async function loadJuicebox() {
    const glue = await import('juicebox-sdk/juicebox-sdk_bg.js');
    const { instance } = await WebAssembly.instantiate(readFileSync(require.resolve('juicebox-sdk/juicebox-sdk_bg.wasm')), {
        './juicebox-sdk_bg.js': glue,
    });
    glue.__wbg_set_wasm(instance.exports);
    return glue;
}
/** Initialised chat-xdk WASM module: `Chat`, `encryptedStreamSize`, `detectMimeType`, `detectImageDimensions`. */
export function chatWasm() {
    wasmPromise ??= once(loadWasm, () => {
        wasmPromise = undefined;
    });
    return wasmPromise;
}
/** A fresh raw chat-xdk engine with every event returned (verification status is reported, not enforced). */
export async function createEngine() {
    const { Chat } = await chatWasm();
    const engine = new Chat();
    engine.setRejectUnverified(false);
    return engine;
}
function juicebox() {
    juiceboxPromise ??= once(loadJuicebox, () => {
        juiceboxPromise = undefined;
    });
    return juiceboxPromise;
}
const toHex = (bytes) => (typeof bytes === 'string' ? bytes.toLowerCase() : Buffer.from(bytes).toString('hex'));
/** Realm auth tokens carried in an X `juicebox_config` (`token_map` entries keyed by realm id). */
export function tokenGetterFromConfig(config) {
    const tokens = new Map();
    for (const entry of Array.isArray(config?.token_map) ? config.token_map : []) {
        if (typeof entry?.key === 'string' && typeof entry?.value?.token === 'string') {
            tokens.set(entry.key.toLowerCase(), entry.value.token);
        }
    }
    return async (realmIdHex) => {
        const token = tokens.get(realmIdHex);
        if (!token) {
            throw new Error(`No Juicebox auth token for realm ${realmIdHex}`);
        }
        return token;
    };
}
function describeJuiceboxError(error) {
    const reason = typeof error?.reason === 'number' ? RECOVER_REASONS[error.reason] : error?.reason;
    const guesses = error?.guesses_remaining ?? error?.guessesRemaining;
    const parts = [reason && `reason=${reason}`, guesses !== undefined && `guesses_remaining=${guesses}`].filter(Boolean);
    return parts.length > 0 ? parts.join(' ') : String(error?.message ?? error);
}
/**
 * Recover the account's 64-byte identity‖signing secret from Juicebox with the Chat PIN.
 * The caller owns the returned bytes and must zero them; `pin` bytes are zeroed here.
 */
export async function recoverIdentitySecret({ juiceboxConfig, pin, getAuthToken }) {
    const config = typeof juiceboxConfig === 'string' ? JSON.parse(juiceboxConfig) : juiceboxConfig;
    const [glue, { juiceboxClientConfig }] = await Promise.all([juicebox(), import('@xdevplatform/chat-xdk')]);
    const tokenFor = getAuthToken ?? tokenGetterFromConfig(config);
    globalThis.JuiceboxGetAuthToken = async (realmId) => tokenFor(toHex(realmId));
    const client = new glue.Client(new glue.Configuration(juiceboxClientConfig(config)), []);
    try {
        // chat-xdk registers with empty `info`; recovery must match it exactly.
        return await client.recover(pin, new Uint8Array(0));
    }
    catch (error) {
        throw new Error(`Juicebox recovery failed: ${describeJuiceboxError(error)}`);
    }
    finally {
        pin.fill(0);
        client.free?.();
    }
}
/** Remaining PIN attempts named in a recovery error, or null. */
export function guessesRemaining(error) {
    const match = /\breason=InvalidPin guesses_remaining=(\d+)\b/.exec(error instanceof Error ? error.message : String(error));
    return match ? Number(match[1]) : null;
}
