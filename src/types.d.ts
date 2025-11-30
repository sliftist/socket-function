export type MaybePromise<T> = T | Promise<T>;
export type Args<T> = T extends (...args: infer V) => any ? V : never;
export type AnyFunction = (...args: any) => any;
export declare function canHaveChildren(value: unknown): value is {
    [key in PropertyKey]: unknown;
};
