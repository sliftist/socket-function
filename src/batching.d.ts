import { AnyFunction } from "./types";
export type DelayType = (number | "afterio" | "immediate" | "afterpromises" | "paintLoop" | "afterPaint");
export declare function delay(delayTime: DelayType, immediateShortDelays?: "immediateShortDelays"): Promise<void>;
export declare function batchFunctionNone<Arg, Result = void>(config: unknown, fnc: (arg: Arg[]) => (Promise<Result> | Result)): (arg: Arg) => Promise<Result>;
export declare function batchFunction<Arg, Result = void>(config: {
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
}, fnc: (arg: Arg[]) => (Promise<Result> | Result)): (arg: Arg) => Promise<Result>;
export declare function runInSerial<T extends (...args: any[]) => Promise<any>>(fnc: T): T;
export declare function runInParallel<T extends (...args: any[]) => Promise<any>>(config: {
    parallelCount: number;
    callTimeout?: number;
}, fnc: T): T;
export declare function runInfinitePoll(delayTime: number, fnc: () => Promise<void> | void): void;
export declare function runInfinitePollCallAtStart(delayTime: number, fnc: () => Promise<void> | void): Promise<void>;
/** Disables polling, called on shutdown. Blocks until all pending poll loops finish */
export declare function shutdownPolling(): Promise<void>;
export declare function retryFunctional<T extends AnyFunction>(fnc: T, config?: {
    maxRetries?: number;
    shouldRetry?: (message: string) => boolean;
    minDelay?: number;
    maxDelay?: number;
}): T;
