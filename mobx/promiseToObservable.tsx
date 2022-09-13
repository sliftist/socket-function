import { observable, Reaction, IObservable } from "mobx";
import { cacheLimited } from "../src/caching";

export function promiseToObservable<T>(promise: Promise<T>): { value: T | undefined } {
    let isDone = false;
    let error: unknown;
    let result: T | undefined;

    let isDoneTrigger = observable({
        value: false
    });
    promise.then(
        r => {
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

    return {
        get value() {
            if (isDone) {
                if (error) throw error;
                return result;
            }
            isDoneTrigger.value;
            return undefined;
        }
    };
}

export function asyncObservable<Output, Key>(maxCount: number, getValue: (key: Key) => Promise<Output>): {
    (key: Key): Output | undefined;
    invalidate(key: Key): void;
    invalidateAll(): void;
} {
    let invalidateAllSeqNum = observable({ seqNum: 1 }, undefined, { deep: false, proxy: false });
    let startingCalculating = new Set<string>();
    let values = new Map<string, {
        valueObs: { value: Output | undefined };
        seqNum: { value: number };
    }>();

    get["invalidate"] = (key: Key) => {
        let hash = JSON.stringify(key);
        let value = values.get(hash);
        if (!value) return;
        values.delete(hash);
        startingCalculating.delete(hash);
        value.seqNum.value++;
    };
    get["invalidateAll"] = () => {
        startingCalculating.clear();
        values.clear();
        invalidateAllSeqNum.seqNum++;
    };
    function get(key: Key) {

        let hash = JSON.stringify(key);
        let value = values.get(hash);
        if (!value) {

            if (startingCalculating.has(hash)) {
                throw new Error(`Cyclic access in cache`);
            }
            startingCalculating.add(hash);

            // Not very efficient, but clearing the entire state is a lot easier to do then
            //  keep track of the order they are accessed (and it does make MOST accesses
            //  MUCH faster).
            if (values.size >= maxCount) {
                values.clear();
                startingCalculating.clear();
            }

            // We call inside another function so that synchronous errors still get wrapped in the observable
            let valueObs = promiseToObservable((async () => getValue(key))());
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