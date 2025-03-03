import { canHaveChildren, MaybePromise } from "./types";
import { formatNumber } from "./formatting/format";

export const timeInSecond = 1000;
export const timeInMinute = timeInSecond * 60;
export const timeInHour = timeInMinute * 60;
export const timeInDay = timeInHour * 24;
export const timeInWeek = timeInDay * 7;
export const timeInYear = timeInDay * 365;

export type Watchable<T> = (callback: (value: T) => void) => MaybePromise<void>;

export function convertErrorStackToError(error: string): Error {
    let errorObj = new Error();
    errorObj.stack = String(error);
    errorObj.message = String(error).split("\n")[0].slice("Error: ".length);
    return errorObj;
}


export function sha256Hash(buffer: Buffer | string): string {
    return require("crypto").createHash("sha256").update(buffer).digest("hex");
}
export function sha256HashBuffer(buffer: Buffer | string): Buffer {
    return require("crypto").createHash("sha256").update(buffer).digest();
}
/** Async, but works both clientside and serverside. */
export async function sha256HashPromise(buffer: Buffer) {
    if (isNode()) {
        return require("crypto").createHash("sha256").update(buffer).digest("hex");
    } else {
        let buf = await window.crypto.subtle.digest("SHA-256", buffer);
        return Buffer.from(buf).toString("hex");
    }
}
export async function sha256BufferPromise(buffer: Buffer): Promise<Buffer> {
    if (isNode()) {
        return require("crypto").createHash("sha256").update(buffer).digest();
    } else {
        let buf = await window.crypto.subtle.digest("SHA-256", buffer);
        return Buffer.from(buf);
    }
}


export function arrayEqual(a: { [key: number]: unknown; length: number }, b: { [key: number]: unknown; length: number },) {
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
    return formatNumber(count);
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

export function keyBy<T, K>(arr: T[], getKey: (value: T) => K): Map<K, T> {
    let map = new Map<K, T>();
    for (let item of arr) {
        map.set(getKey(item), item);
    }
    return map;
}
export function keyByArray<T, K>(arr: T[], getKey: (value: T) => K): Map<K, T[]> {
    let map = new Map<K, T[]>();
    for (let item of arr) {
        let key = getKey(item);
        let arr = map.get(key);
        if (!arr) {
            arr = [];
            map.set(key, arr);
        }
        arr.push(item);
    }
    return map;
}

export function deepCloneJSON<T>(obj: T): T {
    if (obj === undefined) return obj;
    let str = JSON.stringify(obj);
    // It is possible for an object to not be defined, but return undefined when JSON.stringified,
    //  via overriding the toJSON method.
    if (str === undefined) return undefined as any;
    return JSON.parse(str);
}

export class PromiseObj<T = void> {
    public promise: Promise<T>;
    public value: { value?: T; error?: string } | undefined;
    /** Resolve called does not mean the value is ready, as it may be resolved with a promise. */
    public resolveCalled?: boolean;

    public resolve = (value: T | Promise<T>) => {
        this.resolveCalled = true;
        if (typeof value === "object" && value !== null && value instanceof Promise) {
            value.then(
                value => this.value = { value },
                error => this.value = { error },
            );
        } else {
            this.value = { value };
        }
        this.baseResolve(value);
    };
    public reject = (error: any) => {
        this.baseReject(error);
    };

    private baseResolve!: (value: T | Promise<T>) => void;
    private baseReject!: (error: any) => void;
    constructor() {
        this.promise = new Promise<T>((resolve, reject) => {
            this.baseResolve = resolve;
            this.baseReject = reject;
        });
        this.promise.then(
            value => this.value = { value },
            error => this.value = { error }
        );
    }
}

export function promiseObj<T = void>(): PromiseObj<T> {
    return new PromiseObj<T>();
}


// Allows an immediate call, then delays the next call until the first call finishes + delay
//  - Drops all but the latest call, but only resolves the promises return to all
//      calls once the latest call finishes.
//  - Esentially the same as saying "don't run this function too often, don't run it in parallel,
//      and don't let functions runs be too close together".
export function throttleFunction<Args extends any[]>(
    delay: number,
    fnc: (...args: Args) => MaybePromise<void>
): (...args: Args) => Promise<void> {
    let nextAllowedCall = 0;
    let pendingArgs: { args: Args; promiseObj: PromiseObj<void> } | undefined = undefined;
    function doCall(args: Args, promiseObj: PromiseObj<void>) {
        try {
            let result = fnc(...args);
            promiseObj.resolve(result);
            if (result instanceof Promise) {
                // NOTE: The caller should handle the promise. If not, they probably
                //  want the unresolved promise rejection, so they can handle it properly.
                void result.finally(() => {
                    nextAllowedCall = Date.now() + delay;
                    runNextCall();
                });
            } else {
                nextAllowedCall = Date.now() + delay;
                runNextCall();
            }
        } catch (e: any) {
            promiseObj.reject(e);
            nextAllowedCall = Date.now() + delay;
            runNextCall();
        }
    }
    function runNextCall() {
        if (nextAllowedCall === Number.POSITIVE_INFINITY) return;
        if (!pendingArgs) return;
        let time = Date.now();
        if (time > nextAllowedCall) {
            // Set nextAllowedCall to infinity, to prevent new calls from running
            //  until doCall finishes.
            nextAllowedCall = Number.POSITIVE_INFINITY;
            // Delay, so we don't turn a series of sequential calls to a series of nested calls
            //  (which will cause a stack overflow)
            setTimeout(() => {
                let args = pendingArgs;
                pendingArgs = undefined;
                if (!args) {
                    nextAllowedCall = 0;
                    console.warn(`Impossible, pendingArgs was reset when we shouldn't have even been in a call`);
                    return;
                }
                doCall(args.args, args.promiseObj);
            }, 0);
        } else {
            setTimeout(runNextCall, nextAllowedCall - time);
        }
    }
    return function (...args: Args): Promise<void> {
        if (pendingArgs) {
            pendingArgs.args = args;
            return pendingArgs.promiseObj.promise;
        }
        pendingArgs = { args, promiseObj: promiseObj() };
        runNextCall();
        return pendingArgs.promiseObj.promise;
    };
}


export function nextId() {
    return Date.now() + "_" + Math.random();
}

export function arrayFromOrderObject<T>(obj: { [order: number]: T }): T[] {
    if (Array.isArray(obj)) return obj.slice();
    return Object.entries(obj).sort((a, b) => +a[0] - +b[0]).map(x => x[1]).filter(x => x !== undefined && x !== null);
}

export function last<T>(arr: T[]): T | undefined {
    return arr[arr.length - 1];
}

export type ObjectValues<T> = T[keyof T];
export function entries<Obj extends { [key: string]: unknown }>(obj: Obj): [keyof Obj, ObjectValues<Obj>][] {
    return Object.entries(obj) as any;
}

export function keys<Obj extends { [key: string]: unknown }>(obj: Obj): (keyof Obj)[] {
    return Object.keys(obj) as any;
}

export function sort<T>(arr: T[], sortKey: (obj: T) => unknown) {
    if (arr.length <= 1) return arr;
    arr.sort((a, b) => compare(sortKey(a), sortKey(b)));
    return arr;
}

export class QueueLimited<T> {
    private items: T[] = [];
    private nextIndex = 0;
    constructor(private readonly maxCount: number) { }

    public push(item: T): void {
        this.items[this.nextIndex] = item;
        this.nextIndex = (this.nextIndex + 1) % this.maxCount;
    }

    public getAllUnordered(): T[] {
        return this.items;
    }
    public reset(): void {
        this.items = [];
        this.nextIndex = 0;
    }
    public clear(): void {
        this.reset();
    }
    public getOldest(): T | undefined {
        if (this.items.length === 0) return undefined;
        let index = this.nextIndex - 1;

        if (index === -1) {
            index += this.maxCount;
        }
        return this.items[index];
    }
}


export function binarySearchBasic<T, V>(array: T[], getVal: (val: T) => V, searchValue: V): number {
    return binarySearchIndex(array.length, i => compare(getVal(array[i]), searchValue));
}

/**
 *  Searches indexes, allowing you to query structures that aren't arrays. To search an array, use:
 *      `binarySearchIndex(array.length, i => compare(array[i], searchValue))`
 * 
 *      NOTE: If there are duplicates, returns the first match.
 * 
 *      NOTE: If the value can't be found, returns the bitwise negation of the index where it should be inserted.
 *          - If you just want the index which is >=, use `if(index < 0) index = ~index;`
 */
export function binarySearchIndex(listCount: number, compare: (lhsIndex: number) => number): number {
    if (listCount === 0) {
        return ~0;
    }
    let min = 0;
    let max = listCount - 1;
    while (min < max) {
        let fingerIndex = Math.floor((max + min) / 2);
        let comparisonValue = compare(fingerIndex);
        if (comparisonValue < 0) {
            min = fingerIndex + 1;
        } else {
            max = fingerIndex;
        }
    }
    let comparison = compare(min);
    if (comparison === 0) return min;
    if (comparison > 0) return ~min;
    return ~(min + 1);
}

export function compare(lhs: unknown, rhs: unknown): number {
    if (typeof lhs !== typeof rhs) {
        return compare(typeof lhs, typeof rhs);
    }
    if (lhs === rhs) return 0;
    if (lhs === null && rhs !== null) return -1;
    if (lhs !== null && rhs === null) return 1;
    if (typeof lhs === "number") {
        if (Number.isNaN(lhs)) {
            if (Number.isNaN(rhs)) return 0;
            return -1;
        } else {
            if (Number.isNaN(rhs)) return +1;
        }
    }
    if (lhs as any < (rhs as any)) return -1;
    return 1;
}
export function compareArray(lhs: unknown[], rhs: unknown[]): number {
    for (let i = 0; i < Math.min(lhs.length, rhs.length); i++) {
        let comparison = compare(lhs[i], rhs[i]);
        if (comparison !== 0) return comparison;
    }
    return lhs.length - rhs.length;
}

export function insertIntoSortedList<T>(list: T[], map: (val: T) => string | number, element: T) {
    let searchValue = map(element);
    let index = binarySearchIndex(list.length, i => compare(map(list[i]), searchValue));
    if (index < 0) index = ~index;
    list.splice(index, 0, element);
}
export function removeFromSortedList<T>(list: T[], map: (val: T) => string | number, searchValue: string | number) {
    let index = binarySearchIndex(list.length, i => compare(map(list[i]), searchValue));
    if (index < 0) return;
    list.splice(index, 1);
}