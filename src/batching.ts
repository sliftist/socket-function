import { isNode } from "./misc";
import { measureWrap } from "./profiling/measure";
import { MaybePromise } from "./types";

/*
    "numbers" use setTimeout
    "afterpromises" uses a microtask, see https://developer.mozilla.org/en-US/docs/Web/API/HTML_DOM_API/Microtask_guide
    "afterio" uses setImmediate, which will be after all pending and all created promises
        (in the browser it is likely setImmediate will be shimmed with setTimeout)
    "immediate" uses setImmediate, but if not available uses "afterpromises"
        - The ensures a prompt return, without resorting to setTimeout in the browser (which will cause
            the callback to be delayed a frame).
*/
export type DelayType = number | "afterio" | "immediate" | "afterpromises";
export function delay(delayTime: DelayType): Promise<void> {
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
    } else {
        // NOTE: setTimeout can't wait this short of a time, so just setImmediate. This should be hard to distinguish
        //  anyways, as setImmediate (at least in nodejs), should happen after io, so... it should just work
        //  (the only difference is there will be less unnecessary delay).
        // NOTE: THIS DOES break certain cases where io is depending on true delay, and by only waiting a microtick
        //  we don't give it a chance. But... we should just handle those cases explicitly, via an explicit "afterio".
        if (delayTime < 10) {
            return delay("immediate");
        }
        return new Promise<void>(resolve => setTimeout(resolve, delayTime));
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
    },
    fnc: (arg: Arg[]) => (Promise<Result> | Result)
): (arg: Arg) => Promise<Result> {
    fnc = measureWrap(fnc, config.name);

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
            await curPrevPromise;
            await delay(curDelay);
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

    return (async (...args: any[]) => {
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

export function runInfinitePoll(
    delayTime: number,
    fnc: () => Promise<void> | void
) {
    void (async () => {
        while (true) {
            await delay(delayTime);
            try {
                await fnc();
            } catch (e: any) {
                console.error(`Error in infinite poll ${fnc.name || fnc.toString().slice(0, 100).split("\n").slice(0, 2).join("\n")} (continuing poll loop)\n${e.stack}`);
            }
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
                try {
                    await fnc();
                } catch (e: any) {
                    console.error(`Error in infinite poll ${fnc.name} (continuing poll loop)\n${e.stack}`);
                }
            }
        })();
    }
}