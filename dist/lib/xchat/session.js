// ABOUTME: Produces an unlocked chat-xdk engine for the signed-in X account: remembered key first, else the Chat PIN.
// ABOUTME: Headless hosts pass the PIN in CHAT_PIN / BIRDGANG_CHAT_PIN; terminals get a hidden prompt.
import { createEngine, guessesRemaining, recoverIdentitySecret } from './engine.js';
import { forgetKey, loadKey, saveKey } from './keystore.js';
const PIN_ENV = ['BIRDGANG_CHAT_PIN', 'CHAT_PIN'];
function readHiddenLine(prompt) {
    return new Promise((resolve, reject) => {
        const { stdin, stderr } = process;
        const chars = [];
        stderr.write(prompt);
        stdin.setRawMode(true);
        stdin.resume();
        const finish = (error) => {
            stdin.setRawMode(false);
            stdin.pause();
            stdin.off('data', onData);
            stderr.write('\n');
            error ? reject(error) : resolve(Buffer.from(chars.join(''), 'utf8'));
            chars.length = 0;
        };
        const onData = (data) => {
            for (const char of data.toString('utf8')) {
                if (char === '\r' || char === '\n') {
                    return finish();
                }
                if (char === '\u0003') {
                    return finish(new Error('Cancelled'));
                }
                if (char === '\u007f' || char === '\b') {
                    chars.pop();
                }
                else {
                    chars.push(char);
                }
            }
        };
        stdin.on('data', onData);
    });
}
/** The Chat PIN as bytes (the caller's consumer zeroes them): env first, else a hidden terminal prompt. */
export async function readPin({ prompt = 'X Chat PIN: ' } = {}) {
    for (const name of PIN_ENV) {
        if (process.env[name]) {
            return Buffer.from(process.env[name], 'utf8');
        }
    }
    if (process.stdin.isTTY && process.stderr.isTTY) {
        return readHiddenLine(prompt);
    }
    throw new Error(`X Chat is locked: set ${PIN_ENV.join(' or ')}, or run \`birdgang chat unlock --remember\` in a terminal`);
}
/**
 * Unlock the account's chat identity. `ownKeys` is the account's registered key record
 * ({ publicKeyVersion, identityPublicKey, juiceboxConfig, getAuthToken? }) from the transport.
 */
export async function unlock({ userId, ownKeys, remember = false, forcePin = false, store }) {
    if (!ownKeys?.publicKeyVersion || !ownKeys?.identityPublicKey) {
        throw new Error('This X account has no X Chat keys yet; set up encrypted messages in the X app first');
    }
    const keyVersion = String(ownKeys.publicKeyVersion);
    const options = store ? { store } : {};
    const engine = await createEngine();
    let source = 'pin';
    const saved = forcePin ? null : loadKey({ userId }, options);
    if (saved) {
        try {
            engine.importKeys(saved.secret, keyVersion);
        }
        finally {
            saved.secret.fill(0);
        }
        if (saved.keyVersion === keyVersion && engine.matchesRegisteredKey(ownKeys.identityPublicKey)) {
            source = saved.store;
        }
        else {
            // A key from an older registration can no longer read new messages; drop it and ask for the PIN.
            engine.lock();
            forgetKey({ userId }, options);
        }
    }
    let savedTo = null;
    if (source === 'pin') {
        if (!ownKeys.juiceboxConfig) {
            throw new Error('X did not return a Juicebox configuration for this account');
        }
        const pin = await readPin();
        let secret;
        try {
            secret = await recoverIdentitySecret({ juiceboxConfig: ownKeys.juiceboxConfig, pin, getAuthToken: ownKeys.getAuthToken });
        }
        catch (error) {
            const left = guessesRemaining(error);
            throw new Error(left === null ? error.message : `Wrong X Chat PIN (${left} attempt${left === 1 ? '' : 's'} left before the key is locked)`);
        }
        try {
            engine.importKeys(secret, keyVersion);
            if (!engine.matchesRegisteredKey(ownKeys.identityPublicKey)) {
                throw new Error('The recovered key does not match the key registered with X');
            }
            if (remember) {
                savedTo = saveKey({ userId, keyVersion, secret }, options);
            }
        }
        finally {
            secret.fill(0);
        }
    }
    engine.setIdentity(String(userId), keyVersion);
    return { engine, keySource: source, keyVersion, savedTo };
}
