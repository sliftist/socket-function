import debugbreak from "debugbreak";
import { formatTime, formatNumber } from "../formatting/format";
import { red, yellow, blue, magenta } from "../formatting/logColors";

import { getOwnTime, getPendingOwnTimeInstances, getPendingOwnTimeObjs, OwnTimeObj } from "./getOwnTime";
import { addToStats, addToStatsValue, createStatsValue, getStatsTop, StatsValue } from "./stats";
import { white } from "../formatting/logColors";
import { isNode } from "../misc";

/** NOTE: Must be called BEFORE anything else is imported! */
export function enableMeasurements() {
    if (functionsSkipped) {
        console.warn(red(`Skipped measure shimming ${functionsSkipped} functions. Fix this by calling enableMeasurements before any other imports.`));
    }
    measurementsEnabled = true;
}
/** NOTE: Must be called BEFORE anything else is imported! */
export function disableMeasurements() {
    measurementsEnabled = false;
}

let functionsSkipped = 0;

const measureOverhead = 5 / 1000;

const AsyncFunction = (async () => { }).constructor;

// TIMING: 1-5us. I have seen timing values greatly vary, but it does seem to be quite high, despite
//  microbenchmarks saying it is slow. Perhaps it is because getOwnTime breaks the cpu pipeline,
//  which causes slowness for code around us, but not if we are running in isolation?
export function measureFnc(target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    let name = propertyKey;
    if (target.name) {
        name = `${target.name}.${name}`;
    } else {
        let constructorName = target.constructor.name;
        if (constructorName) {
            name = `${constructorName}().${name}`;
        }
    }
    if (descriptor.value instanceof AsyncFunction) {
        name += `(async)`;
    }
    descriptor.value = measureWrap(descriptor.value, name);
}

// https://stackoverflow.com/questions/5905492/dynamic-function-name-in-javascript
export function nameFunction<T extends Function>(name: string, fnc: T) {
    Object.defineProperty(fnc, "name", { value: name });
    return fnc;
}
export function measureWrap<T extends (...args: any[]) => any>(fnc: T, name?: string): T {
    if (!measurementsEnabled) {
        functionsSkipped++;
        return fnc;
    }
    let usedName = name || fnc.name;
    return nameFunction(usedName, (function (this: any, ...args: unknown[]): unknown {
        if (outstandingProfiles.length === 0) {
            return fnc.apply(this, args);
        }
        return getOwnTime(usedName, () => fnc.apply(this, args), recordOwnTime);
    })) as T;
}
export function measureBlock<T extends (...args: any[]) => any>(fnc: T, name?: string): ReturnType<T> {
    return measureWrap(fnc, name)();
}

export function startMeasure(): {
    finish: () => MeasureProfile;
} {
    if (!measurementsEnabled) {
        console.warn(red(`To capture measurements enableMeasurements() must be called before any other imports in your entry point`));
    }
    let profile: MeasureProfile = {
        entries: Object.create(null),
    };
    let openAtStart = new Set(getPendingOwnTimeInstances());

    outstandingProfiles.push(profile);
    return {
        finish() {
            let pending = getPendingOwnTimeObjs() || [];
            for (let timeObj of pending) {
                if (openAtStart.has(timeObj.source)) continue;
                addToProfile(profile, timeObj, true);
            }
            outstandingProfiles.splice(outstandingProfiles.indexOf(profile), 1);
            return profile;
        }
    };
}

export interface LogMeasureTableConfig {
    useTotalTime?: boolean;
    name?: string;
    // Defaults to 0.05
    thresholdInTable?: number;
}

export function logMeasureTable(
    profile: MeasureProfile,
    config?: LogMeasureTableConfig
) {
    let { useTotalTime, name, thresholdInTable } = config || {};
    if (thresholdInTable === undefined) {
        thresholdInTable = 0.05;
    }

    function getTime(entry: ProfileEntry) {
        return useTotalTime ? entry.totalTime : entry.ownTime;
    }
    let entries = Object.values(profile.entries);
    entries.sort((a, b) => getTime(b).sum - getTime(a).sum);

    let totalTime = entries.map(x => getTime(x).sum).reduce((a, b) => a + b, 0);

    console.log();
    let title = yellow(`Profiled ${formatTime(totalTime)} (logged at ${new Date().toISOString()})`);
    if (name) {
        title = `(${blue(name)}) ${title}`;
    }
    console.log(title);
    function percent(value: number) {
        return `${(value * 100).toFixed(2)}%`;
    }

    entries = entries.slice(0, 10);
    let maxNameLength = Math.max(...entries.map(x => x.name.length));

    for (let entry of entries.slice(0, 10)) {
        if (getTime(entry).sum / totalTime < thresholdInTable) break;
        let output = "";
        output += `${blue(entry.name)}`;
        output += Array(maxNameLength + 4 - entry.name.length).fill(" ").join("");

        function p(count: number, text: string | number) {
            return String(text).padStart(count, " ");
        }
        let fractionText = percent(getTime(entry).sum / totalTime);
        let perText = formatTime(getTime(entry).sum / getTime(entry).count);
        let countText = formatNumber(getTime(entry).count);
        let sumText = formatTime(getTime(entry).sum);

        let equation = `${p(6, perText)} per * ${p(6, countText)} = ${p(6, sumText)}`;

        let ownTimeTop = getStatsTop(getTime(entry));
        if (ownTimeTop.topHeavy) {
            let topText = formatTime(ownTimeTop.value);
            let topCountText = formatNumber(ownTimeTop.count);
            let bottomText = formatTime(getTime(entry).sum - ownTimeTop.value, ownTimeTop.value);
            let bottomCountText = formatNumber(getTime(entry).count - ownTimeTop.count);
            let topPart = `${p(6, topText)} per * ${topCountText}`;
            let bottomPart = `${bottomText} * ${bottomCountText}`;
            if (isNode()) {
                topPart = red(topPart);
            } else {
                bottomPart = white(bottomPart);
            }
            equation = `${topPart}  +  ${bottomPart} = ${sumText}`;
        }

        let text = `${p(6, fractionText)} ( ${equation} )`;
        let overhead = measureOverhead * getTime(entry).count;
        let overheadFraction = overhead / getTime(entry).sum;
        let overheadIsAProblem = overheadFraction > 0.5;
        if (overheadIsAProblem) {
            text = yellow(text);
        }

        output += text;

        if (overheadIsAProblem) {
            output += red(`    measurement overhead is ~${percent(overheadFraction)} of the time.`);
        }

        if (entry.stillOpenCount > 0) {
            output += red(`    (${entry.stillOpenCount} open)`);
        }

        console.log(output);
    }
    console.log();
}

export async function measureCode<T>(code: () => Promise<T>, config?: LogMeasureTableConfig) {
    let measure = startMeasure();
    try {
        return await measureBlock(code, code.name || "untracked");
    } finally {
        finishProfile(measure, config);
    }
}
export function measureCodeSync<T>(code: () => T, config?: LogMeasureTableConfig): T {
    let measure = startMeasure();
    try {
        return measureBlock(code, code.name || "untracked");
    } finally {
        finishProfile(measure, config);
    }
}
function finishProfile(measure: { finish(): MeasureProfile }, config?: LogMeasureTableConfig) {
    let profile = measure.finish();
    logMeasureTable(profile, config);
}


export interface MeasureProfile {
    entries: {
        [name: string]: ProfileEntry;
    };
}
export function createMeasureProfile(): MeasureProfile {
    return {
        entries: Object.create(null),
    };
}

export function addToMeasureProfile(base: MeasureProfile, other: MeasureProfile) {
    for (let name in other.entries) {
        let entry = other.entries[name];
        let baseEntry = base.entries[name];
        if (!baseEntry) {
            baseEntry = {
                name: name,
                ownTime: createStatsValue(),
                totalTime: createStatsValue(),
                stillOpenCount: 0,
            };
            base.entries[name] = baseEntry;
        }
        addToStats(baseEntry.ownTime, entry.ownTime);
        addToStats(baseEntry.totalTime, entry.totalTime);
        baseEntry.stillOpenCount += entry.stillOpenCount;
    }
}

interface ProfileEntry {
    name: string;
    ownTime: StatsValue;
    totalTime: StatsValue;
    stillOpenCount: number;
}

let measurementsEnabled = true;

let outstandingProfiles: MeasureProfile[] = [];
function recordOwnTime(ownTimeObj: OwnTimeObj) {
    if (outstandingProfiles.length === 0) return;
    for (let i = 0; i < outstandingProfiles.length; i++) {
        let profile = outstandingProfiles[i];
        addToProfile(profile, ownTimeObj);
    }
}


function addToProfile(profile: MeasureProfile, ownTimeObj: OwnTimeObj, stillOpen?: boolean) {
    let name = ownTimeObj.name;
    let entry = profile.entries[name];
    if (!entry) {
        entry = {
            name: name,
            ownTime: createStatsValue(),
            totalTime: createStatsValue(),
            stillOpenCount: 0,
        };
        profile.entries[name] = entry;
    }
    addToStatsValue(entry.ownTime, ownTimeObj.ownTime);
    addToStatsValue(entry.totalTime, ownTimeObj.time);
    if (stillOpen) {
        entry.stillOpenCount++;
    }
}