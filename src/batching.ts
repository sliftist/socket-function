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
        return new Promise<void>(resolve => setTimeout(resolve, delayTime));
    }
}

export function batchFunction<Arg, Result = void>(
    config: {
        delay: DelayType;
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
    return async arg => {
        if (!batched) {
            await prevPromise;
        }
        if (batched) {
            batched.args.push(arg);
            return await batched.promise;
        }

        let args: Arg[] = [arg];
        let promise = Promise.resolve().then(async () => {
            await delay(config.delay);
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