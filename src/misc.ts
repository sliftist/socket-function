import * as crypto from "crypto";
import { canHaveChildren, MaybePromise } from "./types";

export type Watchable<T> = (callback: (value: T) => void) => MaybePromise<void>;

export function convertErrorStackToError(error: string): Error {
    let errorObj = new Error();
    errorObj.stack = String(error);
    errorObj.message = String(error).split("\n")[0].slice("Error: ".length);
    return errorObj;
}

export function sha256Hash(buffer: Buffer | string): string {
    return crypto.createHash("sha256").update(buffer).digest("hex");
}
export function sha256HashBuffer(buffer: Buffer | string): Buffer {
    return crypto.createHash("sha256").update(buffer).digest();
}
/** Async, but works both clientside and serverside. */
export async function sha256HashPromise(buffer: Buffer) {
    if (isNode()) {
        return crypto.createHash("sha256").update(buffer).digest("hex");
    } else {
        let buf = await window.crypto.subtle.digest("SHA-256", buffer);
        return Buffer.from(buf).toString("hex");
    }
}
export async function sha256BufferPromise(buffer: Buffer): Promise<Buffer> {
    if (isNode()) {
        return crypto.createHash("sha256").update(buffer).digest();
    } else {
        let buf = await window.crypto.subtle.digest("SHA-256", buffer);
        return Buffer.from(buf);
    }
}


export function arrayEqual(a: unknown[], b: unknown[]) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}
export function isNode() {
    return typeof document === "undefined";
}

export function isNodeTrue() {
    return isNode() as true;
}

export function formatNumberSuffixed(count: number): string {
    if (typeof count !== "number") return "0";
    if (count < 0) {
        return "-" + formatNumberSuffixed(-count);
    }

    let absValue = Math.abs(count);

    const extraFactor = 10;
    let divisor = 1;
    let suffix = "";
    if (absValue < 1000 * extraFactor) {

    } else if (absValue < 1000 * 1000 * extraFactor) {
        suffix = "K";
        divisor = 1000;
    } else if (absValue < 1000 * 1000 * 1000 * extraFactor) {
        suffix = "M";
        divisor = 1000 * 1000;
    } else {
        suffix = "B";
        divisor = 1000 * 1000 * 1000;
    }
    count /= divisor;
    absValue /= divisor;

    return Math.round(count).toString() + suffix;
}

export function list(count: number) {
    let arr: number[] = [];
    for (let i = 0; i < count; i++) {
        arr.push(i);
    }
    return arr;
}

export function recursiveFreeze<T>(obj: T): T {
    if (!canHaveChildren(obj)) return obj;
    let visited = new Set<unknown>();
    function iterate(obj: unknown) {
        if (!canHaveChildren(obj)) return;
        if (visited.has(obj)) return;
        visited.add(obj);
        Object.freeze(obj);
        let keys = getKeys(obj);
        for (let key of keys) {
            iterate(obj[key]);
        }
    }
    iterate(obj);
    return obj;
}
export type ArrayBufferViewTypes = Uint8Array | Int8Array | Uint16Array | Int16Array | Uint32Array | Int32Array | BigUint64Array | BigInt64Array | Float64Array | Float32Array | Uint8ClampedArray;
export type BufferType = ArrayBuffer | SharedArrayBuffer | ArrayBufferViewTypes;
export function isBufferType(obj: unknown): obj is BufferType {
    if (typeof obj !== "object") return false;
    if (!obj) return false;
    if (ArrayBuffer.isView(obj)) return true;
    if (obj instanceof ArrayBuffer) return true;
    if (global.SharedArrayBuffer && obj instanceof global.SharedArrayBuffer) return true;
    return false;
}
export function getKeys(obj: unknown) {
    if (typeof obj !== "object" && typeof obj !== "function" || obj === null) {
        return [];
    }
    if (obj instanceof MessagePort) {
        return [];
    }
    let keyArray: PropertyKey[];
    if (isBufferType(obj)) {
        keyArray = [];
    } else if (Array.isArray(obj)) {
        // NOTE: We convert the indexes to strings, because that is what javascript does,
        //  and differing from it causes regressions that we simply cannot rectify (it breaks hashing
        //  consistency).
        keyArray = Array(obj.length).fill(0).map((x, i) => String(i));
    } else {
        keyArray = Object.keys(obj);
    }
    for (let symbol of Object.getOwnPropertySymbols(obj)) {
        let key = Symbol.keyFor(symbol);
        if (key) {
            keyArray.push(symbol);
        }
    }
    return keyArray;
}
export function getStringKeys<T extends {}>(obj: T): ((keyof T) & string)[] {
    return Object.keys(obj) as any;
}

if (isNode()) {
    // TODO: Find a better place for this...
    process.on("unhandledRejection", async (reason: any, promise) => {
        console.error(`Uncaught promise rejection: ${String(reason.stack || reason)}`);
    });
}