import { arrayEqual } from "./misc";
import { AnyFunction, Args, canHaveChildren } from "./types";

export function lazy<T>(factory: () => T) {
    let value: { value: T } | undefined = undefined;
    function get() {
        if (!value) {
            value = { value: factory() };
        }
        return value.value;
    };
    get.reset = () => {
        value = undefined;
    };
    return get;
}

// NOTE: The reason we need to periodically clear, is because sometimes a very small
//      part of a large payload (ex, persisted overrides) is cached, which then results
//      in the whole payload being cached, which results in a lot of memory being used.

// IMPORTANT! The cleanup functions CANNOT close upon anything, or else they will cause leaks!
//  All data they use should be in data.
interface CleanupFnc<T extends object> {
    (data: T): void;
}


// NOTE: Empty arrays are so common, that it is useful to represent them as the same
//  emtpy array, to increase cache hit rates.
const emptyArray: any[] = [];
export function cacheEmptyArray<T>(array: T[]): T[] {
    if (array.length === 0) return emptyArray;
    return array;
}

export function cache<Output, Key>(getValue: (key: Key) => Output): {
    (key: Key): Output;
    // NOTE: If you want to clear all, just make a new cache!
    clear(key: Key): void;
    clearAll(): void;
    forceSet(key: Key, value: Output): void;
    getAllKeys(): Key[];
    get(key: Key): Output | undefined;
} {
    let startingCalculating = new Set<Key>();
    let values = new Map<Key, Output>();
    function cache(input: Key) {
        let key = input;
        if (values.has(key)) {
            return values.get(key) as any;
        }
        if (startingCalculating.has(key)) {
            // TODO: Fix the types here, by throwing, and then for the cases
            //  that don't throw, make our output type include undefined
            return undefined;
        }
        startingCalculating.add(key);
        let value = getValue(input);
        values.set(key, value);
        return value;
    }
    cache.clear = (key: Key) => {
        values.delete(key);
        startingCalculating.delete(key);
    };
    cache.forceSet = (key: Key, value: Output) => {
        values.set(key, value);
        startingCalculating.add(key);
    };
    cache.getAllKeys = () => {
        return [...values.keys()];
    };
    cache.get = (key: Key) => {
        return values.get(key);
    };
    cache.clearAll = () => {
        values.clear();
        startingCalculating.clear();
    };
    return cache;
}


/** Makes a cache that limits the number of entries, allowing you to put arbitrary data in it
 *      without worrying about leaking memory
  */
export function cacheLimited<Output, Key>(
    // NOTE: We can't calculate what limit should be based on comparing the evaluation time
    //  and the time to compare against the values. Because, even if finding a match takes far longer than
    //  calculating, keeping a consistent output can save (a considerable amount of) time in downstream caches.
    maxCount: number,
    getValue: (key: Key) => Output
) {
    let startingCalculating = new Set<Key>();
    let values = new Map<Key, Output>();
    function get(input: Key): Output {
        let key = input;
        if (values.has(key)) {
            return values.get(key) as any;
        }
        if (startingCalculating.has(key)) {
            throw new Error(`Cyclic access in cache`);
        }
        startingCalculating.add(key);

        // Clear when it gets too big. This is kind of like a worse
        //  least recently used cache, because entries that are accessed
        //  often will quickly get put back in. This is effective as long
        //  as accesses take similar amounts of time. If there is a very slow
        //  and very commonly accessed value, it could be evicted by many very
        //  fast accesses, which would be unfortunate.
        if (values.size >= maxCount) {
            values.clear();
            startingCalculating.clear();
        }

        let value = getValue(input);
        values.set(key, value);
        return value;
    }
    get["forceSet"] = (key: Key, value: Output) => {
        values.set(key, value);
        startingCalculating.add(key);
    };
    get["clearKey"] = (key: Key) => {
        values.delete(key);
        startingCalculating.delete(key);
    };
    get["clear"] = () => {
        values.clear();
        startingCalculating.clear();
    };

    return get;
}

export function cacheWeak<Output, Key extends object>(getValue: (key: Key) => Output): (key: Key) => Output {
    let state = {
        startingCalculating: new WeakSet<Key>(),
        values: new WeakMap<Key, Output>(),
    };

    return (input) => {
        let key = input;
        if (state.values.has(key)) {
            return state.values.get(key) as any;
        }
        if (state.startingCalculating.has(key)) {
            throw new Error(`Cyclic access in cacheWeak`);
        }
        state.startingCalculating.add(key);
        let value = getValue(input);
        state.values.set(key, value);
        return value;
    };
}

// A list cache, which... maybe faster than a Map?
export function cacheList<Value>(
    getLength: () => number,
    getValue: (index: number) => Value,
): { (index: number): Value; } {
    let state = {
        cache: [] as Value[],
        length: undefined as undefined | number,
        getLength,
    };
    function get(i: number) {
        let cache = state.cache;
        let length = state.length;
        if (length === undefined) {
            length = state.length = state.getLength();
        }
        if (i < 0 || i >= length) {
            throw new Error(`Index out of bounds`);
        }
        if (!(i in cache)) {
            cache[i] = getValue(i);
        }
        return cache[i];
    };
    return get;
}

function cacheArrayEqualCleanup(state: any) {
    state.cache = [];
}

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
export function cacheArrayEqual<Input extends unknown[] | undefined, Output>(
    map: (arrays: Input) => Output,
    limit = 10
): {
    (array: Input): Output;
    clear(array: Input): void;
    clearAll(): void;
} {
    let state: {
        cache: {
            input: Input;
            output: Output;
        }[]
    } = { cache: [] };
    function isMatch(lhs: Input, rhs: Input) {
        if (lhs === rhs) {
            return true;
        }
        if (lhs === undefined || rhs === undefined) {
            return false;
        }
        if (arrayEqual(lhs, rhs)) {
            return true;
        }
        return false;
    }
    return Object.assign(
        (input: Input) => {
            let cache = state.cache;
            for (let obj of cache) {
                if (isMatch(obj.input, input)) {
                    return obj.output;
                }
            }
            let output = map(input);
            cache.unshift({ input, output });
            while (cache.length > limit) {
                cache.pop();
            }
            return output;
        },
        {
            clear(array: Input) {
                for (let i = state.cache.length - 1; i >= 0; i--) {
                    if (isMatch(state.cache[i].input, array)) {
                        state.cache.splice(i, 1);
                    }
                }
            },
            clearAll() {
                state.cache = [];
            },
        }
    );
}

/** Caches when arguments are ===. See cacheArrayEqual */
export function cacheArgsEqual<Fnc extends AnyFunction>(
    fnc: Fnc,
    limit = 10
): Fnc & { clear(...args: Args<Fnc>): void } {
    let cache = cacheArrayEqual((args: unknown[]) => {
        return fnc(...args);
    }, limit);
    return Object.assign(
        ((...args: unknown[]) => {
            return cache(args);
        }) as Fnc,
        {
            clear(...args: unknown[]) {
                cache.clear(args);
            },
        }
    );
}

export function cacheJSONArgsEqual<Fnc extends AnyFunction>(
    fnc: Fnc,
    limit = 10
) {
    let cache = cacheLimited(limit, (argsJSON: string) => {
        return fnc(...JSON.parse(argsJSON));
    });
    return Object.assign(
        ((...args: unknown[]) => {
            return cache(JSON.stringify(args));
        }) as Fnc,
        {
            clear(...args: unknown[]) {
                cache.clearKey(JSON.stringify(args));
            },
            clearAll() {
                cache.clear();
            }
        }
    );
}

export function cacheShallowConfigArgEqual<Fnc extends AnyFunction>(
    fnc: Fnc,
    limit = 10
): Fnc & {
    clear(...args: Args<Fnc>): void;
    clearAll(): void;
} {
    let cache = cacheArrayEqual((kvpsFlat: unknown[]) => {
        output.missCount++;
        let arg: any;
        if (kvpsFlat.length === 1) {
            arg = kvpsFlat[0];
        } else {
            let kvps: [unknown, unknown][] = [];
            for (let i = 0; i < kvpsFlat.length; i += 2) {
                kvps.push([kvpsFlat[i], kvpsFlat[i + 1]]);
            }
            arg = Object.fromEntries(kvps);
        }
        return fnc(arg);
    }, limit);
    function getKVPs(configArg: object) {
        if (!canHaveChildren(configArg) || Array.isArray(configArg)) {
            return [configArg];
        }
        let keys = Object.keys(configArg);
        keys.sort();
        return keys.flatMap(key => [key, configArg[key]]);
    }
    let output = Object.assign(
        ((configArg: object) => {
            output.callCount++;
            return cache(getKVPs(configArg));
        }) as Fnc,
        {
            clear(configArg: object) {
                cache.clear(getKVPs(configArg));
            },
            clearAll() {
                cache.clearAll();
            },
            callCount: 0,
            missCount: 0,
        }
    );
    return output;
}


export function externalCache<Key, Value>(): {
    get: (key: Key) => Value | undefined;
    set: (key: Key, value: Value) => void;
} {
    let values = new Map<Key, Value>();
    return {
        get: (key) => {
            return values.get(key);
        },
        set: (key, value) => {
            values.set(key, value);
        },
    };
}