/** Fixed Promise.race, which doesn't leak promises values. Promises still leak the Promise object themselves, but a Promise is < 100 bytes, where as the promise VALUE might be arbitrarily large.
 */
export function PromiseRace<T extends any[]>(promises: { [K in keyof T]: Promise<T[K]> }): Promise<T[number]> {
    return new PromiseLessLeaky((resolve: any, reject: any) => {
        function onFinally() {
            for (let promise of promises) {
                if (promise && typeof promise === "object" && promise instanceof Promise) {
                    let callbackObj = promiseCallbacks.get(promise);
                    if (!callbackObj) continue;
                    remove(callbackObj.onResolve, resolve);
                    remove(callbackObj.onReject, reject);
                    remove(callbackObj.onFinally, onFinally);
                }
            }
        }
        for (let promise of promises) {
            // NOTE: This "if" statement greatly reduce leaks, although it might
            //  reduce speed as well?
            if (promise && typeof promise === "object" && promise instanceof Promise) {
                let callbackObj = promiseCallbacks.get(promise);
                let firstSetup = false;
                if (!callbackObj) {
                    firstSetup = true;
                    callbackObj = {
                        onResolve: [],
                        onReject: [],
                        onFinally: [],
                    };
                    promiseCallbacks.set(promise, callbackObj);
                }
                callbackObj.onResolve.push(resolve);
                callbackObj.onReject.push(reject);
                callbackObj.onFinally.push(onFinally);
                // We need to delay this in case we're immediately triggered, because we're already resolved. 
                if (firstSetup) {
                    connectPromiseToCallbackObj(promise, callbackObj);
                }
                continue;
            }

            void Promise.resolve(promise).then(resolve, reject);
        }
    }) as any;
}

function remove(list: any, value: any) {
    let index = list.indexOf(value);
    if (index >= 0) {
        list.splice(index, 1);
    }
}
const promiseCallbacks = new WeakMap();

function connectPromiseToCallbackObj(promise: any, callbackObj: any) {
    // NOTE: If the promise stays alive forever... this will leak callbackObj. BUT,
    //  it is only called once per promise, ever, so... the leak isn't so bad!
    promise.then(
        (value: any) => {
            // We need to delete the callback lists once on finally happens. Because we only connect to the promise once, And so it'll only trigger us once. So removing it is the only way to get it to trigger us again if someone subscribes to a finished promise. 
            promiseCallbacks.delete(promise);
            for (let fnc of callbackObj.onResolve.slice()) {
                try { fnc(value); } catch { }
            }
        },
        (value: any) => {
            promiseCallbacks.delete(promise);
            for (let fnc of callbackObj.onReject.slice()) {
                try { fnc(value); } catch { }
            }
        }
    ).finally(() => {
        for (let fnc of callbackObj.onFinally.slice()) {
            try { fnc(); } catch { }
        }
    });
}


// Less leaky promise.
//  See https://github.com/nodejs/node/issues/17469
//  See https://bugs.chromium.org/p/v8/issues/detail?id=9858#c9
// Basically, make resolve/reject weakly reference the Promise, so that
//  resolved promises aren't kept alive. The `resolve` function is still leaked
//  itself, but at least it doesn't leak the underlying data.
// IMPORTANT! This still leaks! So... maybe don't even use Promise.race?
class PromiseLessLeaky extends Promise<any> {
    constructor(executor: any) {
        super((resolve, reject) => {
            executor(
                function PromiseLessLeakyResolved(value: any) {
                    let callback = resolve;
                    resolve = undefined as any;
                    reject = undefined as any;
                    if (callback) {
                        callback(value);
                    }
                },
                function PromiseLessLeakyRejected(value: any) {
                    let callback = reject;
                    resolve = undefined as any;
                    reject = undefined as any;
                    if (callback) {
                        callback(value);
                    }
                }
            );
            executor = undefined;
        });
    }
}
