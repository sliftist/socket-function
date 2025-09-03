
// Less leaky promise.
//  See https://github.com/nodejs/node/issues/17469
//  See https://bugs.chromium.org/p/v8/issues/detail?id=9858#c9
// Basically, make resolve/reject weakly reference the Promise, so that
//  resolved promises aren't kept alive. The `resolve` function is still leaked
//  itself, but at least it doesn't leak the underlying data.
export class PromiseLessLeaky<T> extends Promise<T> {
    constructor(executor: ((
        resolve: (value: T | PromiseLike<T>) => void,
        reject: (reason?: any) => void
    ) => void) | undefined
    ) {
        super(((
            resolve: ((value: T | PromiseLike<T>) => void) | undefined,
            reject: ((reason?: any) => void) | undefined
        ) => {
            executor?.(
                function PromiseLessLeakyResolved(value) {
                    let callback = resolve;
                    resolve = undefined;
                    reject = undefined;
                    if (callback) {
                        callback(value);
                    }
                },
                function PromiseLessLeakyRejected(value) {
                    let callback = reject;
                    resolve = undefined;
                    reject = undefined;
                    if (callback) {
                        callback(value);
                    }
                }
            );
            executor = undefined;
        }));
    }
}
function remove<T>(list: T[], value: T) {
    let index = list.indexOf(value);
    if (index >= 0) {
        list.splice(index, 1);
    }
}
const promiseCallbacks = new WeakMap<object, {
    onResolve: ((value: any) => void)[];
    onReject: ((value: any) => void)[];
    onFinally: (() => void)[];
}>();
/** A promise race function which doesn't leak, unlike Promise.race

    See https://github.com/nodejs/node/issues/17469
    See https://bugs.chromium.org/p/v8/issues/detail?id=9858#c9

 */
export function promiseRace<T extends readonly unknown[] | []>(promises: T): Promise<Awaited<T[number]>> {
    return new PromiseLessLeaky((resolve, reject) => {
        let actualPromises: Promise<unknown>[] = [];
        function onFinally() {
            for (let promise of actualPromises) {
                let callbackObj = promiseCallbacks.get(promise);
                if (!callbackObj) continue;
                remove(callbackObj.onResolve, resolve);
                remove(callbackObj.onReject, reject);
                remove(callbackObj.onFinally, onFinally);
            }
        }
        for (let promise of promises) {
            // If not a thenable, use Promise.resolve to make it a promise, and use the build in functions, as it won't hold a reference because it will resolve immediately.
            if (!(promise && (typeof promise === "object" || typeof promise === "function") && ("then" in promise))) {
                Promise.resolve(promise).then(resolve as any, reject);
                continue;
            }
            actualPromises.push(promise as Promise<unknown>);
            let callbackObj = promiseCallbacks.get(promise);
            if (!callbackObj) {
                callbackObj = {
                    onResolve: [],
                    onReject: [],
                    onFinally: [],
                };
                promiseCallbacks.set(promise, callbackObj);
                connectPromiseToCallbackObj(Promise.resolve(promise), callbackObj);
            }
            callbackObj.onResolve.push(resolve);
            callbackObj.onReject.push(reject);
            callbackObj.onFinally.push(onFinally);
        }
    }) as any;
};

function connectPromiseToCallbackObj(promise: Promise<any>, callbackObj: {
    onResolve: ((value: any) => void)[];
    onReject: ((value: any) => void)[];
    onFinally: (() => void)[];
}) {
    // NOTE: If the promise stays alive forever... this will leak callbackObj. BUT,
    //  it is only called once per promise, ever, so... the leak isn't so bad!
    promise.then(
        value => {
            for (let fnc of callbackObj.onResolve) {
                try { fnc(value); } finally { }
            }
        },
        value => {
            for (let fnc of callbackObj.onReject) {
                try { fnc(value); } finally { }
            }
        }
    ).finally(() => {
        for (let fnc of callbackObj.onFinally) {
            try { fnc(); } finally { }
        }
    });
}


async function main() {
    const { formatTime } = await import("./formatting/format");
    const os = require("os");
    let count = 0;

    // @ts-ignore
    function createNamedObject(name) {
        return eval(`(class ${name} {  
            memory = (() => {
                // let memory = new Float64Array(1024 * 1024);
                // for (let i = 0; i < memory.length; i++) {
                //     memory[i] = Math.random();
                // }
                // return memory;
            })();
        })`);
    }
    let LeakedTag = createNamedObject("LeakedTag");
    let LeakedTag2 = createNamedObject("LeakedTag2");
    function createPromiseObj<T>() {
        let resolve!: ((value: T | PromiseLike<T>) => void);
        let reject!: ((reason?: any) => void);
        let promise = new Promise<T>((_resolve, _reject) => {
            resolve = _resolve;
            reject = _reject;
        });
        void promise.finally(() => {
            (globalThis as any)["keepAliveValueTest"] = ((globalThis as any)["keepAliveValueTest"] || 0) + 1;
        });
        return {
            promise,
            resolve,
            reject,
        };
    }

    let exitPromiseObj = createPromiseObj<void>();
    setTimeout(() => {
        exitPromiseObj.resolve(undefined);
    }, 1000 * 60 * 60);

    async function doWork() {
        return new LeakedTag();
    }

    // @ts-ignore
    let createRace: (promises: Promise<any>[]) => Promise<any>;

    // Leaks (you can see LeakedTag in the heap dump, and also usage goes to the moon)
    //createRace = promises => Promise.race(promises);

    // Doesn't leak
    createRace = promises => promiseRace(promises);

    let time = Date.now();

    while (true) {
        await createRace([doWork(), exitPromiseObj.promise]);
        count++;
        if (count % 100000 === 0) {
            let duration = Date.now() - time;
            console.log(`Did ${count} test runs, used memory is at ${(process.memoryUsage().heapUsed)}, time per count is ${formatTime(duration / count)}`);
        }
    }
}
//void main();