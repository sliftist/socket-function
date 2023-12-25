import debugbreak from "debugbreak";
// TODO: We could probably make this an optional / dev dependency, to allow
//  for use on machines without the ability to compile?
import { now } from "rdtsc-now";

export type OwnTimeObj = {
    name: string;
    time: number;
    ownTime: number;
};
export type OwnTimeObjInternal = OwnTimeObj & {
    lastStartTime: number;
    firstStartTime: number;
};

let openTimes: OwnTimeObjInternal[] = [];

export function getOpenTimesBase(): OwnTimeObjInternal[] {
    return openTimes;
}

(global as any).pendingOwnCallTime = openTimes;

// NOTE: This overhead time is actually mostly for aggregate time, but it is needed,
//  otherwise we consistently underestimate the time spent.
//  ALSO! This forces high count lines to be at the top of the aggregate time list, which is really important!
// NOTE: The overhead time greatly varies, but even if it only takes 100ns, if 10X of that
//  is significant, you are probably spending too much timing profiling anyway!
export const measureOverheadTime = 500 / 1000 / 1000;
// We internally add, because of where we measure time, there is time spent before we grab the
//  current time, and after we record the last time, that is lost, but should be added.
let addMeasureOverheadTime = 0;
{
    // NOTE: This is going to vary considerably. I assume because sometimes we are on a core
    //  that is free, and other times we are on a core that is hyperthreading with another hardware
    //  thread. This really hurts us because our timing uses rdtsc, which really hates hyper threading,
    //  and can easily get 50% slower because of it.
    let results: number[] = [];
    for (let j = 0; j < 10; j++) {
        const measureCount = 1000 * 10;
        let time = now();
        for (let i = 0; i < measureCount; i++) {
            getOwnTime("test", () => { }, () => { });
        }
        time = now() - time;
        let overhead = time / measureCount;
        results.push(overhead);
    }
    results.sort((a, b) => a - b);
    addMeasureOverheadTime = results[results.length / 2];
}

// TIMING: About 60ns, of which 40ns is just now() calls.
//  If async is closer to 300ns.
// NOTE: Handles promises correctly
export function getOwnTime<T>(
    name: string,
    code: () => T,
    onTime: (obj: OwnTimeObj) => void
): T {
    let time = now();
    let obj: OwnTimeObjInternal = {
        name,
        time: 0,
        ownTime: 0,
        firstStartTime: time,
        lastStartTime: time,
    };
    let prevOwnTime = openTimes[openTimes.length - 1];
    if (prevOwnTime) {
        prevOwnTime.ownTime += time - prevOwnTime.lastStartTime;
    }
    openTimes.push(obj);

    function finish() {
        let time = now();
        obj.time = time - obj.firstStartTime;
        if (obj === openTimes[openTimes.length - 1]) {
            obj.ownTime += time - obj.lastStartTime;
            let newOwnTime = openTimes[openTimes.length - 2];
            if (newOwnTime) {
                newOwnTime.lastStartTime = time;
            }
        }
        let index = openTimes.indexOf(obj);
        openTimes.splice(index, 1);

        obj.time += addMeasureOverheadTime;
        obj.ownTime += addMeasureOverheadTime;

        onTime(obj);
    }

    let isAsync = false;
    try {
        let result = code();
        if (result && typeof result === "object" && result instanceof Promise) {
            isAsync = true;
            return result.finally(() => {
                finish();
            }) as any;
        }
        return result;
    } finally {
        if (!isAsync) {
            finish();
        }
    }
}