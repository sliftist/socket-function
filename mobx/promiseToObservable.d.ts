export interface InternalResult {
    result: {
        value: unknown;
    } | undefined;
}
export declare function promiseToObservable<T>(promise: Promise<T>, staleValue?: T): {
    value: T | undefined;
};
