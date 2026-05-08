import { AnyFunction, MaybePromise } from "./types";
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
export declare function runInfinitePoll(delayTime: number, fnc: () => Promise<void> | void, stopObj?: {
    stop: boolean;
}): void;
export declare function runInfinitePollCallAtStart(delayTime: number, fnc: () => Promise<void> | void, stopObj?: {
    stop: boolean;
}): Promise<void>;
/** Disables polling, called on shutdown. Blocks until all pending poll loops finish */
export declare function shutdownPolling(): Promise<void>;
export declare function retryFunctional<T extends AnyFunction>(fnc: T, config?: {
    maxRetries?: number;
    shouldRetry?: (message: string) => boolean;
    minDelay?: number;
    maxDelay?: number;
}): T;
/** @deprecated Use safeLoop instead */
export declare const throttledLoop: typeof unblockLoop;
/** @deprecated Use safeLoop instead */
export declare function unblockLoop<T, R>(config: {
    data: T[];
    maxBlockingTime?: number;
    backOffTime?: number;
} | T[], fnc: (item: T) => MaybePromise<R>): Promise<R[]>;
export declare function safeLoop<T, R>(config: {
    data: T[];
    fnc: (item: T) => MaybePromise<R>;
    /** If set, yields after blocking for this many ms. ONLY applies if your function does not return promises. Default = 1000ms */
    maxBlockingTime?: number;
    /** Fraction of time spent active vs yielded. e.g. 0.5 => after running X ms, wait X ms before continuing. */
    maxActiveFraction?: number;
    doNotWarnOnSlow?: boolean;
    name?: string;
}): Promise<R[]>;
