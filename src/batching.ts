import { isNode } from "./misc";
import { measureWrap } from "./profiling/measure";

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
        if (delayTime < 10) {
            return delay("immediate");
        }
        return new Promise<void>(resolve => setTimeout(resolve, delayTime));
    }
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
    let batched: {
        args: Arg[];
        promise: Promise<Result>;
    } | undefined;
    let curDelay = config.delay;
    let delayRamp = 0;
    if (config.throttleWindow && typeof curDelay === "number") {
        delayRamp = curDelay / config.throttleWindow;
    }
    let delayTime = 0;
    if (typeof curDelay === "number") {
        delayTime = curDelay;
    }
    let countSinceBreak = 0;
    let lastCall = 0;
    return async arg => {
        let now = Date.now();
        if (delayRamp) {
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

        if (!batched) {
            await prevPromise;
        }
        if (batched) {
            batched.args.push(arg);
            return await batched.promise;
        }

        let args: Arg[] = [arg];
        let promise = Promise.resolve().then(async () => {
            await delay(curDelay);
            // After we call the function, we can no longer accept args
            batched = undefined;
            return await fnc(args);
        });
        batched = {
            args,
            promise,
        };
        // We need to prevent new calls from starting when the previous call can no longer accept
        //  args, BUT, before it has finished.
        prevPromise = batched.promise;

        return await promise;
    };
}

export function runInSerial<T extends (...args: any[]) => Promise<any>>(fnc: T): T {
    let updateQueue: (() => void)[] = [];

    return (async (...args: any[]) => {
        const queueWasEmpty = updateQueue.length === 0;
        if (!queueWasEmpty) {
            // Wait for the previous promise to resolve
            await new Promise<void>(resolve => updateQueue.push(resolve));
        }
        updateQueue.push(() => { });

        try {
            return await fnc(...args);
        } finally {
            // Pop ourself off
            updateQueue.shift();
            // Resolve the next promise
            updateQueue[0]?.();
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