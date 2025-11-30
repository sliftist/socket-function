/// <reference types="node" />
/// <reference types="node" />
import { MaybePromise } from "./types";
export declare const timeInSecond = 1000;
export declare const timeInMinute: number;
export declare const timeInHour: number;
export declare const timeInDay: number;
export declare const timeInWeek: number;
export declare const timeInYear: number;
export type Watchable<T> = (callback: (value: T) => void) => MaybePromise<void>;
export declare function convertErrorStackToError(error: string): Error;
export declare function sha256Hash(buffer: Buffer | string): string;
export declare function sha256HashBuffer(buffer: Buffer | string): Buffer;
/** Async, but works both clientside and serverside. */
export declare function sha256HashPromise(buffer: Buffer): Promise<any>;
export declare function sha256BufferPromise(buffer: Buffer): Promise<Buffer>;
export declare function arrayEqual(a: {
    [key: number]: unknown;
    length: number;
}, b: {
    [key: number]: unknown;
    length: number;
}): boolean;
export declare function isNode(): boolean;
export declare function isNodeTrue(): true;
export declare function formatNumberSuffixed(count: number): string;
export declare function list(count: number): number[];
export declare function recursiveFreeze<T>(obj: T): T;
export type ArrayBufferViewTypes = Uint8Array | Int8Array | Uint16Array | Int16Array | Uint32Array | Int32Array | BigUint64Array | BigInt64Array | Float64Array | Float32Array | Uint8ClampedArray;
export type BufferType = ArrayBuffer | SharedArrayBuffer | ArrayBufferViewTypes;
export declare function isBufferType(obj: unknown): obj is BufferType;
export declare function getKeys(obj: unknown): PropertyKey[];
export declare function getStringKeys<T extends {}>(obj: T): ((keyof T) & string)[];
export declare function keyBy<T, K>(arr: T[], getKey: (value: T) => K): Map<K, T>;
export declare function keyByArray<T, K>(arr: T[], getKey: (value: T) => K): Map<K, T[]>;
export declare function deepCloneJSON<T>(obj: T): T;
export declare class PromiseObj<T = void> {
    promise: Promise<T>;
    value: {
        value?: T;
        error?: string;
    } | undefined;
    /** Resolve called does not mean the value is ready, as it may be resolved with a promise. */
    resolveCalled?: boolean;
    resolve: (value: T | Promise<T>) => void;
    reject: (error: any) => void;
    private baseResolve;
    private baseReject;
    constructor();
}
export declare function promiseObj<T = void>(): PromiseObj<T>;
export declare function throttleFunction<Args extends any[]>(delay: number, fnc: (...args: Args) => MaybePromise<void>): (...args: Args) => Promise<void>;
export declare function nextId(): string;
export declare function arrayFromOrderObject<T>(obj: {
    [order: number]: T;
}): T[];
export declare function last<T>(arr: T[]): T | undefined;
export type ObjectValues<T> = T[keyof T];
export declare function entries<Obj extends {
    [key: string]: unknown;
}>(obj: Obj): [keyof Obj, ObjectValues<Obj>][];
export declare function keys<Obj extends {
    [key: string]: unknown;
}>(obj: Obj): (keyof Obj)[];
export declare function sort<T>(arr: T[], sortKey: (obj: T) => unknown): T[];
export declare function getRootDomain(hostname: string): string;
export declare class QueueLimited<T> {
    private readonly maxCount;
    private items;
    private nextIndex;
    constructor(maxCount: number);
    push(item: T): void;
    getAllUnordered(): T[];
    reset(): void;
    clear(): void;
    getOldest(): T | undefined;
}
export declare function binarySearchBasic<T, V>(array: T[], getVal: (val: T) => V, searchValue: V): number;
export declare function binarySearchBasic2<T, V>(array: T[], getVal: (val: T) => V, searchValue: T): number;
/**
 *  Searches indexes, allowing you to query structures that aren't arrays. To search an array, use:
 *      `binarySearchIndex(array.length, i => compare(array[i], searchValue))`
 *
 *      NOTE: If there are duplicates, returns the first match.
 *
 *      NOTE: If the value can't be found, returns the bitwise negation of the index where it should be inserted.
 *
 *      NOTE: With `if (index < 0) index = ~index;` you will get an index of the value >= the target value.
 */
export declare function binarySearchIndex(listCount: number, compare: (lhsIndex: number) => number): number;
export declare function compare(lhs: unknown, rhs: unknown): number;
export declare function compareArray(lhs: unknown[], rhs: unknown[]): number;
export declare function insertIntoSortedList<T>(list: T[], map: (val: T) => string | number, element: T): void;
export declare function removeFromSortedList<T>(list: T[], map: (val: T) => string | number, searchValue: string | number): void;
export declare function timeoutToError<T>(time: number, p: Promise<T>, err: () => Error): Promise<T>;
export declare function timeoutToUndefined<T>(time: number, p: Promise<T>): Promise<T | undefined>;
export declare function timeoutToUndefinedSilent<T>(time: number, p: Promise<T>): Promise<T | undefined>;
export declare function errorToWarning<T>(promise: Promise<T>): void;
