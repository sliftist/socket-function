import { AnyFunction, Args } from "./types";
export declare function lazy<T>(factory: () => T): {
    (): T;
    reset(): void;
    set(newValue: T): void;
};
export declare function cacheEmptyArray<T>(array: T[]): T[];
export declare function cache<Output, Key, Untracked extends unknown[]>(getValue: (key: Key, ...untracked: Untracked) => Output): {
    (key: Key, ...untracked: Untracked): Output;
    clear(key: Key): void;
    clearAll(): void;
    forceSet(key: Key, value: Output): void;
    getAllKeys(): Key[];
    get(key: Key): Output | undefined;
};
/** Makes a cache that limits the number of entries, allowing you to put arbitrary data in it
 *      without worrying about leaking memory
  */
export declare function cacheLimited<Output, Key>(maxCount: number, getValue: (key: Key) => Output): {
    (input: Key): Output;
    forceSet(key: Key, value: Output): void;
    clearKey(key: Key): void;
    clear(): void;
};
export declare function cacheWeak<Output, Key extends object>(getValue: (key: Key) => Output): (key: Key) => Output;
export declare function cacheList<Value>(getLength: () => number, getValue: (index: number) => Value): {
    (index: number): Value;
};
/** A cache half way between caching based on === and caching based on hash. Caches
 *      based on arrayEqual, which does === on all values in an array. Requires localized
 *      caching (as the comparisons don't scale with many candidates, unlike hashing),
 *      however works with non trival transformations (ex, resolving many persisted overrides
 *      to get a value), unlike cache().
 *  Also, limits itself, more of a performance optimization than memory optimization, as it scales
 *      very poorly with the number of candidates.
 *
 *  TIMING: About 6us with limit = 100, array size = 294, and the cache being full.
 */
export declare function cacheArrayEqual<Input extends unknown[] | undefined, Output>(map: (arrays: Input) => Output, limit?: number): {
    (array: Input): Output;
    clear(array: Input): void;
    clearAll(): void;
};
/** Caches when arguments are ===. See cacheArrayEqual */
export declare function cacheArgsEqual<Fnc extends AnyFunction>(fnc: Fnc, limit?: number): Fnc & {
    clear(...args: Args<Fnc>): void;
};
export declare function cacheJSONArgsEqual<Fnc extends AnyFunction>(fnc: Fnc, limit?: number): Fnc & {
    clear(...args: unknown[]): void;
    clearAll(): void;
};
export declare function cacheShallowConfigArgEqual<Fnc extends AnyFunction>(fnc: Fnc, limit?: number): Fnc & {
    clear(configObj: Args<Fnc>[0]): void;
    clearAll(): void;
};
export declare function externalCache<Key, Value>(): {
    get: (key: Key) => Value | undefined;
    set: (key: Key, value: Value) => void;
};
