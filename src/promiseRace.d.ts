export declare class PromiseLessLeaky<T> extends Promise<T> {
    constructor(executor: ((resolve: (value: T | PromiseLike<T>) => void, reject: (reason?: any) => void) => void) | undefined);
}
/** A promise race function which doesn't leak, unlike Promise.race

    See https://github.com/nodejs/node/issues/17469
    See https://bugs.chromium.org/p/v8/issues/detail?id=9858#c9

 */
export declare function promiseRace<T extends readonly unknown[] | []>(promises: T): Promise<Awaited<T[number]>>;
