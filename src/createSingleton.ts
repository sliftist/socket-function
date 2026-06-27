// A namespace on globalThis that holds state shared across every copy of this package that
//  happens to be loaded in the same process. When two (type-compatible) versions of
//  socket-function end up installed at once - ex, as nested dependencies - each gets its own
//  set of module instances, so module-level registries (exposed classes, the node connection
//  cache, mount state, ...) would otherwise be split into disconnected copies, and a call
//  routed through one copy wouldn't see a class registered through the other. Every copy of
//  this file references the same string literal below, so they all read and write the same
//  underlying store, letting compatible versions share that state instead.
const GLOBAL_KEY = "__socketFunctionSingletons__";

interface SingletonStore {
    values: { [key: string]: unknown };
    // name => the set of versions that have been requested, so we can warn when incompatible
    //  versions are loaded together (which is the situation that makes sharing impossible).
    versions: { [name: string]: Set<string> };
}

function getStore(): SingletonStore {
    let store = (globalThis as any)[GLOBAL_KEY] as SingletonStore | undefined;
    if (!store) {
        store = { values: Object.create(null), versions: Object.create(null) };
        (globalThis as any)[GLOBAL_KEY] = store;
    }
    return store;
}

export interface Singleton<T> {
    get(): T;
    set(value: T): void;
}

/** Stores a value on globalThis so it is shared across every copy of socket-function loaded in
 *      the process, provided each copy passes the same name and version. Use this only for state
 *      that MUST be process-global to stay correct when multiple compatible versions are installed
 *      at once - ex, the registry of exposed classes, the node connection cache, and mount state.
 *      Regular config and caches that are fine to keep per-copy should NOT use this.
 *  - version is part of the identity. Bump it only when the shape of the stored value changes in a
 *      way that makes an old and a new copy unable to safely share it. Copies that disagree on the
 *      version get separate slots (so they will NOT share), which is the correct outcome, as they
 *      can't interoperate - and we warn so the situation is visible.
 *  - getDefault runs at most once per name+version, lazily, the first time get() is called.
 *  - For a value that is mutated in place (a Map/Set/array/object), just call get() once and keep
 *      the reference. For a value that gets reassigned (a primitive, or a whole-object swap), use
 *      get()/set() at each access so every copy sees the latest.
 */
export function createSingleton<T>(
    name: string,
    version: string | number,
    getDefault: () => T,
): Singleton<T> {
    const store = getStore();
    const versionStr = String(version);
    const key = `${name}@${versionStr}`;

    let seenVersions = store.versions[name];
    if (!seenVersions) {
        seenVersions = store.versions[name] = new Set();
    }
    seenVersions.add(versionStr);
    if (seenVersions.size > 1) {
        console.warn(`socket-function: singleton ${JSON.stringify(name)} requested at multiple versions (${Array.from(seenVersions).join(", ")}). These copies will NOT share state, which usually means incompatible versions of a package are loaded at once.`);
    }

    return {
        get(): T {
            const values = store.values;
            if (!(key in values)) {
                values[key] = getDefault();
            }
            return values[key] as T;
        },
        set(value: T) {
            store.values[key] = value;
        },
    };
}
