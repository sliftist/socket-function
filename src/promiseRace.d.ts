/** Fixed Promise.race, which doesn't leak promises values. Promises still leak the Promise object themselves, but a Promise is < 100 bytes, where as the promise VALUE might be arbitrarily large.
 */
export declare function PromiseRace<T extends any[]>(promises: {
    [K in keyof T]: Promise<T[K]>;
}): Promise<T[number]>;
