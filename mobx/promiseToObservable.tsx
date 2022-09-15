import { observable, Reaction, IObservable } from "mobx";
import { cacheLimited } from "../src/caching";

interface InternalResult {
    result: { value: unknown } | undefined;
}
export function promiseToObservable<T>(promise: Promise<T>, staleValue?: T): { value: T | undefined } {
    let isDone = false;
    let error: unknown;
    let result: T | undefined;

    let internalResult: InternalResult = { result: undefined };

    let isDoneTrigger = observable({
        value: false
    });
    promise.then(
        r => {
            internalResult.result = { value: r };
            result = r;
            isDoneTrigger.value = true;
            isDone = true;
        },
        e => {
            error = e;
            isDoneTrigger.value = true;
            isDone = true;
        }
    );

    return Object.assign({
        get value() {
            if (isDone) {
                if (error) throw error;
                return result;
            }
            isDoneTrigger.value;
            return staleValue;
        }
    }, { internalResult });
}

export function asyncObservable<Output, Args extends any[]>(maxCount: number, getValue: (...args: Args) => Promise<Output>): {
    (...args: Args): Output | undefined;
    invalidate(...args: Args): void;
    invalidateAll(): void;
} {
    let invalidateAllSeqNum = observable({ seqNum: 1 }, undefined, { deep: false, proxy: false });
    let startingCalculating = new Set<string>();
    let values = new Map<string, {
        valueObs: { value: Output | undefined };
        seqNum: { value: number };
    }>();
    let staleValues = new Map<string, Output>();

    get["invalidate"] = (...args: Args) => {
        let hash = JSON.stringify(args);
        let value = values.get(hash);
        if (!value) return;
        // Access the value specially, to prevent causing a mobx subscription
        let internalValue = (value.valueObs as any as { internalResult: InternalResult }).internalResult;
        if (internalValue.result) {
            staleValues.set(hash, internalValue.result.value as any);
        }
        values.delete(hash);
        startingCalculating.delete(hash);
        value.seqNum.value++;
    };
    get["invalidateAll"] = () => {
        // HACK: It sucks to have to iterate over everything, but... our maxCount is limited anyway, so... hopefully it isn't too slow?
        //  TODO: If we are iterating anyway... we should probably just store a LRU queue for cache eviction...
        for (let [hash, value] of values) {
            // Access the value specially, to prevent causing a mobx subscription
            let internalValue = (value.valueObs as any as { internalResult: InternalResult }).internalResult;
            if (internalValue.result) {
                staleValues.set(hash, internalValue.result.value as any);
            }
        }

        startingCalculating.clear();
        values.clear();
        invalidateAllSeqNum.seqNum++;
    };
    function get(...args: Args) {
        let hash = JSON.stringify(args);
        let value = values.get(hash);
        if (!value) {

            if (startingCalculating.has(hash)) {
                throw new Error(`Cyclic access in cache`);
            }
            startingCalculating.add(hash);

            // Not very efficient, but clearing the entire state is a lot easier to do then
            //  keep track of the order they are accessed (and it does make MOST accesses
            //  MUCH faster).
            if (values.size >= maxCount || staleValues.size > maxCount) {
                values.clear();
                startingCalculating.clear();
                staleValues.clear();
            }

            // We call inside another function so that synchronous errors still get wrapped in the observable
            let valueObs = promiseToObservable((async () => getValue(...args))(), staleValues.get(hash));
            value = {
                valueObs,
                seqNum: observable({ value: 1 }, undefined, { deep: false, proxy: false }),
            };
            values.set(hash, value);
        }
        invalidateAllSeqNum.seqNum;
        value.seqNum.value;
        return value.valueObs.value;
    }
    return get;
}