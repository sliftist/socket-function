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
/** Redefines the given (already initialized) properties of target as accessors onto a singleton, so
 *      `Target.SOME_SETTING = x` configures every copy of the package instead of only the copy the
 *      caller happened to import (which is otherwise decided by module resolution, and so is
 *      essentially arbitrary from the caller's perspective). The properties' current values become
 *      the defaults, so config statics stay defined inline in the class as usual - just call this
 *      below the class with the list of statics to share.
 *  - Same versioning rules as createSingleton, except that adding a property is not a shape change:
 *      a copy that knows about a property older copies don't backfills it below.
 */
export declare function defineSingletonConfig<T extends object>(target: T, name: string, version: string | number, keys: (keyof T & string)[]): void;
