import debugbreak from "debugbreak";
// TODO: We could probably make this an optional / dev dependency, to allow
//  for use on machines without the ability to compile?
import { now } from "rdtsc-now";

export type OwnTimeObj = {
    name: string;
    time: number;
    ownTime: number;
};
type OwnTimeObjInternal = OwnTimeObj & {
    lastStartTime: number;
    firstStartTime: number;
    parent: OwnTimeObjInternal | undefined;
    child: OwnTimeObjInternal | undefined;
};

let pendingCallTime: OwnTimeObjInternal | undefined;
export function getPendingOwnTimeObjs(): (OwnTimeObj & { source: OwnTimeObjInternal })[] | undefined {
    let time = now();
    let instances = getPendingOwnTimeInstances();
    if (!instances) return undefined;
    if (!pendingCallTime) return undefined;
    let results = instances.map((instance) => ({
        name: instance.name,
        ownTime: instance.ownTime,
        time: time - instance.firstStartTime,
        source: instance
    }));
    results[0].ownTime += time - pendingCallTime.lastStartTime;
    return results;
}
export function getPendingOwnTimeInstances(): OwnTimeObjInternal[] | undefined {
    if (!pendingCallTime) return undefined;
    let results: OwnTimeObjInternal[] = [];
    let current: OwnTimeObjInternal | undefined = pendingCallTime;
    while (current) {
        results.push(current);
        current = current.parent;
    }
    return results;
}
(global as any).pendingOwnCallTime = pendingCallTime;

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
        parent: pendingCallTime,
        child: undefined,
    };
    if (pendingCallTime) {
        pendingCallTime.child = obj;
    }
    pendingCallTime = obj;
    if (obj.parent) {
        obj.parent.ownTime += obj.lastStartTime - obj.parent.lastStartTime;
    }

    function finish() {
        let time = now();
        obj.time = time - obj.firstStartTime;
        if (pendingCallTime === obj) {
            // Good case, all of our children call ended before us.

            // End our own time calculation
            obj.ownTime += time - obj.lastStartTime;

            // Our parent is now the last open call
            pendingCallTime = obj.parent;
            if (pendingCallTime) {
                // Resume our parent ownTime counting
                pendingCallTime.lastStartTime = time;
            }
        }
        if (obj.child && obj.parent) {
            obj.child.parent = obj.parent;
            obj.parent.child = obj.child;
        }
        obj.parent = undefined;
        obj.child = undefined;

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