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
export declare function createSingleton<T>(name: string, version: string | number, getDefault: () => T): Singleton<T>;
