import { observable, Reaction, IObservable } from "mobx";
import { cacheLimited } from "../src/caching";

export interface InternalResult {
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
