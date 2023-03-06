export type MaybePromise<T> = T | Promise<T>;

export type Args<T> = T extends (...args: infer V) => any ? V : never;

export type AnyFunction = (...args: any) => any;

export function canHaveChildren(value: unknown): value is { [key in PropertyKey]: unknown } {
    return typeof value === "object" && value !== null || typeof value === "function";
}