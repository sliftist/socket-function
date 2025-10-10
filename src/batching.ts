import { PromiseObj, isNode, timeoutToError } from "./misc";
import { measureWrap } from "./profiling/measure";
import { AnyFunction, Args, MaybePromise } from "./types";

/*
    "numbers" use setTimeout
    "afterpromises" uses a microtask, see https://developer.mozilla.org/en-US/docs/Web/API/HTML_DOM_API/Microtask_guide
    "afterio" uses setImmediate, which will be after all pending and all created promises
        (in the browser it is likely setImmediate will be shimmed with setTimeout)
    "immediate" uses setImmediate, but if not available uses "afterpromises"
        - The ensures a prompt return, without resorting to setTimeout in the browser (which will cause
            the callback to be delayed a frame).
*/
export type DelayType = (
    number | "afterio" | "immediate" | "afterpromises"
    // Waits for paint, usable in a loop. The first wait doesn't wait until the next
    //  wait, but the second wait will.
    | "paintLoop"
    // Waits until after paint, by waiting twice.
    | "afterPaint"
)
export function delay(
    delayTime: DelayType,
    // Delays < 10ms become "immediate"
    immediateShortDelays?: "immediateShortDelays"
): Promise<void> {
    if (delayTime === "afterio") {
        return new Promise<void>(resolve => setImmediate(resolve));
    } else if (delayTime === "afterpromises") {
        // NOTE: We use a promise here as it might be a bit easier to debug than queueMicrotask.
        //  It is equivalent though...
        return Promise.resolve();
    } else if (delayTime === "immediate") {
        if (isNode()) {
            return new Promise<void>(resolve => setImmediate(resolve));
        } else {
            return delay("afterpromises");
        }
    } else if (delayTime === "paintLoop") {
        if (isNode()) {
            return delay("immediate");
        }
        return (async () => {
            await new Promise(resolve => requestAnimationFrame(resolve));
        })();
    } else if (delayTime === "afterPaint") {
        if (isNode()) {
            return delay("immediate");
        } else {
            return (async () => {
                await new Promise(resolve => requestAnimationFrame(resolve));
                // Before first paint
                await new Promise(resolve => requestAnimationFrame(resolve));
                // After first paint
            })();
        }
    } else {

        if (delayTime < 10 && immediateShortDelays) {
            // NOTE: setTimeout can't wait this short of a time, so just setImmediate. This should be hard to distinguish
            //  anyways, as setImmediate (at least in nodejs), should happen after io, so... it should just work
            //  (the only difference is there will be less unnecessary delay).
            // NOTE: THIS DOES break certain cases where io is depending on true delay, and by only waiting a microtick
            //  we don't give it a chance. But... we should just handle those cases explicitly, via an explicit "afterio".
            return delay("immediate");
        }
        // NOTE: We check Date.now() and wait longer if setTimeout didn't wait long enough.
        return (async () => {
            let targetTime = Date.now() + delayTime;
            while (true) {
                let timeToWait = targetTime - Date.now();
                await new Promise<void>(resolve => setTimeout(resolve, timeToWait));
                if (Date.now() >= targetTime) {
                    break;
                }
            }
        })();
    }
}

// NOTE: This is an easy way to turn off batching, without having to strip the extra batch handling code
export function batchFunctionNone<Arg, Result = void>(
    config: unknown,
    fnc: (arg: Arg[]) => (Promise<Result> | Result)
): (arg: Arg) => Promise<Result> {
    return async arg => fnc([arg]);
}

export function batchFunction<Arg, Result = void>(
    config: {
        delay: DelayType;
        /** Instead of immediately waiting delay, starts by waiting 0ms, and every call increments the delay factor
         *      by 1. Delay is `factor * (delay / throttleWindow)`. For every delay interval we have no calls, we decrease by
         *      no_calls/delay.
         *      - This essentially turns delay into a `calls per second` type indicator (ex, 10ms is 100 callers
         *          per second, 500ms is 2 calls, etc), which is accurate over delay * throttleWindow time.
         */
        throttleWindow?: number;
        name?: string;
        noMeasure?: boolean;
    },
    fnc: (arg: Arg[]) => (Promise<Result> | Result)
): (arg: Arg) => Promise<Result> {
    if (!config.noMeasure) {
        fnc = measureWrap(fnc, config.name);
    }

    let prevPromise: Promise<Result> | undefined;
    let batching: {
        args: Arg[];
        promise: Promise<Result>;
    } | undefined;
    let curDelay = config.delay;
    let delayRamp = 0;
    if (config.throttleWindow && typeof curDelay === "number") {
        delayRamp = curDelay / (config.throttleWindow / curDelay);
    }
    let delayTime = 0;
    if (typeof curDelay === "number") {
        delayTime = curDelay;
    }
    let countSinceBreak = 0;
    let lastCall = 0;

    return arg => {
        let now = Date.now();
        if (delayRamp) {
            // The time since the last call (started) is how much budget we will have received to
            //  run values. If it is === delayTime, then we subtract 1, as we are right on track.
            //  If it is > delayTime, then we are running below the rate, so it is fine.
            //  If it is < delayTime, we are running too fast, and have to slow down.
            let savedCount = (now - lastCall) / delayTime;
            if (savedCount >= 1) {
                countSinceBreak -= savedCount;
            }
            if (countSinceBreak < 0) {
                countSinceBreak = 0;
            }

            countSinceBreak++;
            // Set the max fairly high, as we basically ignore small delay times, so we need a high max to allow
            //  our delay to even apply!
            curDelay = Math.min(delayTime * 20, delayRamp * countSinceBreak);
        }
        lastCall = now;

        if (batching) {
            batching.args.push(arg);
            return batching.promise;
        }

        let curPrevPromise = prevPromise;
        let args: Arg[] = [arg];
        let promise = Promise.resolve().then(async () => {
            // Ignore the error. New callers don't care about errors in previous calls,
            //  as they are unrelated to the current call, and just break valid calls
            //  due to invalid calls.
            try {
                await curPrevPromise;
            } catch { }
            await delay(curDelay, "immediateShortDelays");
            // Reset batching, as we once we start the function we can't accept args. `prevPromise` will block
            //  the next batch from starting before we finish.
            batching = undefined;
            return await fnc(args);
        });
        batching = { args, promise, };
        prevPromise = batching.promise;

        return promise;
    };
}

export function runInSerial<T extends (...args: any[]) => Promise<any>>(fnc: T): T {
    let updateQueue: { promise: Promise<void>; resolve: () => void; }[] = [];

    return (async function runInSerial(...args: any[]) {
        let promise = {
            promise: null as any as Promise<void>,
            resolve: () => { },
        };
        promise.promise = new Promise<void>(resolve => {
            promise.resolve = resolve;
        });
        const queueWasEmpty = updateQueue.length === 0;
        if (queueWasEmpty) {
            promise.resolve();
        }
        updateQueue.push(promise);
        await promise.promise;

        try {
            return await fnc(...args);
        } finally {
            // Pop ourself off
            updateQueue.shift();
            // Resolve the next promise
            updateQueue[0]?.resolve();
        }
    }) as T;
}


export function runInParallel<T extends (...args: any[]) => Promise<any>>(
    config: {
        parallelCount: number;
        callTimeout?: number;
    },
    fnc: T
): T {
    let queued: {
        parameters: Args<T>;
        result: PromiseObj<ReturnType<T>>;
    }[] = [];
    let runningCount = 0;

    function runIfNeeded() {
        if (runningCount >= config.parallelCount) {
            return;
        }
        const queuedObj = queued.shift();
        if (!queuedObj) return;

        queuedObj.result.resolve((async () => {
            runningCount++;
            try {
                if (config.callTimeout) {
                    return await timeoutToError(config.callTimeout, fnc(...queuedObj.parameters), () => new Error(`Parallel call timed out for fnc ${fnc.name}`));
                } else {
                    return await fnc(...queuedObj.parameters);
                }
            } finally {
                runningCount--;
                runIfNeeded();
            }
        })());
    }

    function parallelCall(...args: Args<T>) {
        queued.push({
            parameters: args,
            result: new PromiseObj<ReturnType<T>>(),
        });
        let queuedObj = queued[queued.length - 1];
        runIfNeeded();
        return queuedObj.result.promise;
    }
    return parallelCall as T;
}

let pollingRunning = true;
let pendingPolls = new Set<Promise<unknown>>();

export function runInfinitePoll(
    delayTime: number,
    fnc: () => Promise<void> | void
) {
    void (async () => {
        while (pollingRunning) {
            await delay(delayTime);
            if (!pollingRunning) break;
            await runPollFnc(fnc);
        }
    })();
}

export async function runInfinitePollCallAtStart(
    delayTime: number,
    fnc: () => Promise<void> | void
) {
    try {
        return await fnc();
    } finally {
        void (async () => {
            while (true) {
                await delay(delayTime);
                if (!pollingRunning) break;
                await runPollFnc(fnc);
            }
        })();
    }
}

async function runPollFnc(fnc: () => Promise<void> | void) {
    let promise = (async () => {
        try {
            return await fnc();
        } catch (e: any) {
            console.error(`Error in infinite poll ${fnc.name || fnc.toString().slice(0, 100)} (continuing poll loop)\n${e.stack}`);
        }
    })();
    pendingPolls.add(promise);
    await promise;
    pendingPolls.delete(promise);
}

/** Disables polling, called on shutdown. Blocks until all pending poll loops finish */
export async function shutdownPolling() {
    pollingRunning = false;
    await Promise.all(Array.from(pendingPolls));
}


const DEFAULT_RETRY_DELAY = 5000;
const DEFAULT_MAX_RETRIES = 3;
export function retryFunctional<T extends AnyFunction>(fnc: T, config?: {
    maxRetries?: number;
    shouldRetry?: (message: string) => boolean;
    minDelay?: number;
    maxDelay?: number;
}): T {
    let { maxRetries = DEFAULT_MAX_RETRIES, shouldRetry, minDelay = DEFAULT_RETRY_DELAY, maxDelay = DEFAULT_RETRY_DELAY } = config || {};
    let expFactor = Math.max(1, Math.log(maxDelay / minDelay) / Math.log(Math.max(maxRetries, 2)));
    async function runFnc(args: any[], retries: number): Promise<ReturnType<T>> {
        try {
            return await (fnc as any)(...args);
        } catch (e: any) {
            if (shouldRetry && !shouldRetry(String(e.stack))) {
                throw e;
            }
            if (retries < 0) throw e;
            console.warn(`Retrying ${fnc.name}, due to error ${String(e.stack)}`);
            retries--;
            let curCount = maxRetries - retries;
            await delay(minDelay * expFactor ** curCount);
            return runFnc(args, retries);
        }
    }
    return async function (...args: any[]) {
        return await runFnc(args, maxRetries);
    } as any;
}