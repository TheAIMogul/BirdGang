// ABOUTME: Read-only Thrift binary-protocol reader for X Chat events and decrypted message contents.
// ABOUTME: Structs decode to { [fieldId]: value }; strings stay raw bytes until text() is asked for.
const TYPE = { STOP: 0, BOOL: 2, BYTE: 3, DOUBLE: 4, I16: 6, I32: 8, I64: 10, STRING: 11, STRUCT: 12, MAP: 13, SET: 14, LIST: 15 };
const MAX_DEPTH = 64;
const utf8 = new TextDecoder('utf-8');
class Reader {
    constructor(bytes) {
        this.bytes = bytes;
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        this.pos = 0;
    }
    take(n) {
        if (n < 0 || this.pos + n > this.bytes.length) {
            throw new Error('Truncated Thrift data');
        }
        const at = this.pos;
        this.pos += n;
        return at;
    }
    count() {
        const n = this.view.getInt32(this.take(4));
        // Every element occupies at least one byte, so a larger count can only be corrupt input.
        if (n < 0 || n > this.bytes.length - this.pos) {
            throw new Error('Invalid Thrift collection size');
        }
        return n;
    }
    value(type, depth) {
        switch (type) {
            case TYPE.BOOL:
                return this.bytes[this.take(1)] !== 0;
            case TYPE.BYTE:
                return this.view.getInt8(this.take(1));
            case TYPE.DOUBLE:
                return this.view.getFloat64(this.take(8));
            case TYPE.I16:
                return this.view.getInt16(this.take(2));
            case TYPE.I32:
                return this.view.getInt32(this.take(4));
            case TYPE.I64:
                return this.view.getBigInt64(this.take(8));
            case TYPE.STRING: {
                const n = this.view.getInt32(this.take(4));
                const at = this.take(n);
                return this.bytes.subarray(at, at + n);
            }
            case TYPE.STRUCT:
                return this.struct(depth + 1);
            case TYPE.MAP: {
                const keyType = this.bytes[this.take(1)];
                const valueType = this.bytes[this.take(1)];
                const out = new Map();
                for (let n = this.count(); n > 0; n -= 1) {
                    const key = this.value(keyType, depth);
                    out.set(key instanceof Uint8Array ? utf8.decode(key) : key, this.value(valueType, depth));
                }
                return out;
            }
            case TYPE.SET:
            case TYPE.LIST: {
                const elementType = this.bytes[this.take(1)];
                const out = [];
                for (let n = this.count(); n > 0; n -= 1) {
                    out.push(this.value(elementType, depth));
                }
                return out;
            }
            default:
                throw new Error(`Unknown Thrift type ${type}`);
        }
    }
    struct(depth = 0) {
        if (depth > MAX_DEPTH) {
            throw new Error('Thrift data nested too deeply');
        }
        const out = {};
        for (;;) {
            const type = this.bytes[this.take(1)];
            if (type === TYPE.STOP) {
                return out;
            }
            const id = this.view.getInt16(this.take(2));
            out[id] = this.value(type, depth);
        }
    }
}
export function readStruct(bytes) {
    return new Reader(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).struct();
}
export function readBase64Struct(b64) {
    return readStruct(Buffer.from(b64, 'base64'));
}
/** UTF-8 text of a Thrift string field (undefined when absent). */
export function text(value) {
    if (value === undefined || value === null) {
        return undefined;
    }
    return value instanceof Uint8Array ? utf8.decode(value) : String(value);
}
/** Decimal string of an id-like field, whether X sent it as a string or an i64. */
export function ident(value) {
    return typeof value === 'bigint' ? value.toString() : text(value);
}
/** Number of an integer field (i64 included); undefined when absent. */
export function num(value) {
    if (value === undefined || value === null) {
        return undefined;
    }
    return typeof value === 'bigint' ? Number(value) : Number(text(value));
}
/** The single set member of a Thrift union as [fieldId, value], or [] when empty. */
export function union(value) {
    if (!value || typeof value !== 'object') {
        return [];
    }
    for (const key of Object.keys(value)) {
        return [Number(key), value[key]];
    }
    return [];
}
