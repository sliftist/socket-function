import { SocketFunction } from "../SocketFunction";
import { blue, green, red, yellow } from "../src/formatting/logColors";
import { isNode } from "../src/misc";

// IMPORTANT! We don't ensure that the times of return are unique. We cannot ensure they are unique because the amount of precision is only about ten thousand date times per millisecond, Which would mean if the calling code called date.now frequently enough, which doesn't even have to be that frequent, it could slowly drift farther and farther ahead of the real time, which would be really bad.

module.allowclient = true;


const UPDATE_VERIFY_COUNT = 3;

const UPDATE_TRANSITION_GAP = 1000 * 60 * 20;
const UPDATE_CHECK_INTERVAL = 1000 * 60 * 5;
const DEBUG_TIME_SYNC = false;

const FETCH_RETRY_INITIAL_DELAY = 1000;
const FETCH_RETRY_MAX_DELAY = 1000 * 30;
const FETCH_MAX_FAILURES = 8;
const NTP_TIMEOUT = 1000 * 10;

// The on-disk LMDB database can become corrupt (ex, a process killed mid-write). After this many
//  consecutive failed operations we stop just reopening the handle and delete the files to start
//  fresh - the data is only a cached time offset, so wiping it merely forces a re-measurement.
const LMDB_MAX_CORRUPTION_FAILURES = 3;

// Time can never go backwards, but we can run at a slower rate until the output time allows
//      the real time to catch up with it.
const MINIMUM_TIME_RATE = 0.5;

// The offset tweens toward its target at this fraction of elapsed real time, then plateaus once it gets there. Must stay below 1 so output time keeps moving forward even while the offset is shrinking. Tweening across the whole transition window instead would mean a badly-off clock (many seconds) takes the entire window to converge, which breaks transactional consistency with other machines.
const OFFSET_TWEEN_RATE = 0.5;

const THROW_ON_ERROR = false;

// Hugely important as if we don't synchronize between processes, it means our logs are going to be confusing and out of order.
//  - Of course, cross-machine, the logs could be out of order. However, due to the latency between machines, that's less likely. The latency will probably be a few milliseconds, and hopefully, our time isn't more than a few milliseconds off of the real time. However, between processes, the latency could easily be microseconds, and our time will absolutely certainly be microseconds off of the real time.
let USE_LMDB_PROCESS_SYNC = true;

// Browser tabs synchronize via localStorage, for the same reason processes synchronize via LMDB.
const TIME_OFFSET_LOCAL_STORAGE_KEY = "socket-function-time-offset";

function debugLog(...args: any[]) {
    if (DEBUG_TIME_SYNC) {
        console.log("[TimeSync]", ...args);
    }
}

// The raw evidence behind an offset measurement. sendTime/receiveTime are on the local system clock, serverTime is the remote clock's timestamp, and offset is derived from them by assuming the server timestamped at the midpoint of the round trip.
export type TimeOffsetProof = {
    sendTime: number;
    receiveTime: number;
    serverTime: number;
    offset: number;
};

export type TimeOffsetMeasurement = {
    offset: number;
    proof?: TimeOffsetProof;
};

type TimeOffsetData = {
    lastOffset: number;
    lastUpdateTime: number;
    offset: number;
    updateTime: number;
    nextOffset: number;
    nextUpdateTime: number;
    // Proof of the most recent measurement (the one that produced nextOffset).
    proof?: TimeOffsetProof;
};

let cachedTimeOffsetData: TimeOffsetData | undefined = undefined;
let didFirstTimeSync = false;
let onFirstTimeSync!: () => void;
let firstTimeSyncPromise = new Promise<void>((resolve) => {
    onFirstTimeSync = resolve;
});
function markFirstTimeSync() {
    if (didFirstTimeSync) return;
    didFirstTimeSync = true;
    onFirstTimeSync();
}

const baseGetTime = Date.now;
let lastTime = 0;
let lastBaseTime = 0;

export function getTimeComponentsDetailed(): {
    systemTime: number;
    fromOffset: number;
    toOffset: number;
    fromTime: number;
    toTime: number;
} {
    const systemTime = baseGetTime();
    const data = cachedTimeOffsetData;

    if (!data) {
        return {
            systemTime,
            fromOffset: 0,
            toOffset: 0,
            fromTime: systemTime,
            toTime: systemTime,
        };
    }

    if (systemTime < data.lastUpdateTime) {
        // Before everything (shouldn't happen)
        if (THROW_ON_ERROR) throw new Error(`systemTime ${systemTime} is before lastUpdateTime ${data.lastUpdateTime}`);
        return {
            systemTime,
            fromOffset: data.lastOffset,
            toOffset: data.lastOffset,
            fromTime: data.lastUpdateTime,
            toTime: data.lastUpdateTime,
        };
    } else if (systemTime < data.updateTime) {
        // Smear between lastOffset and offset
        return {
            systemTime,
            fromOffset: data.lastOffset,
            toOffset: data.offset,
            fromTime: data.lastUpdateTime,
            toTime: data.updateTime,
        };
    } else if (systemTime < data.nextUpdateTime) {
        // Smear between offset and nextOffset
        return {
            systemTime,
            fromOffset: data.offset,
            toOffset: data.nextOffset,
            fromTime: data.updateTime,
            toTime: data.nextUpdateTime,
        };
    } else {
        // Past everything (shouldn't happen often)
        if (THROW_ON_ERROR) throw new Error(`systemTime ${systemTime} is past nextUpdateTime ${data.nextUpdateTime}`);
        return {
            systemTime,
            fromOffset: data.nextOffset,
            toOffset: data.nextOffset,
            fromTime: data.nextUpdateTime,
            toTime: data.nextUpdateTime,
        };
    }
}

export function computeTweenedOffset(components: {
    systemTime: number;
    fromOffset: number;
    toOffset: number;
    fromTime: number;
}): number {
    const elapsed = Math.max(0, components.systemTime - components.fromTime);
    const delta = components.toOffset - components.fromOffset;
    const maxChange = elapsed * OFFSET_TWEEN_RATE;
    if (Math.abs(delta) <= maxChange) {
        return components.toOffset;
    }
    return components.fromOffset + Math.sign(delta) * maxChange;
}

export function getTimeComponents(): { systemTime: number; offset: number } {
    const detailed = getTimeComponentsDetailed();
    return { systemTime: detailed.systemTime, offset: computeTweenedOffset(detailed) };
}

export function getTrueTime() {
    const { systemTime, offset } = getTimeComponents();
    let time = systemTime + offset;

    // Only adjust time once we have a time offset. Otherwise systems with a really bad clock
    //  might take days be correct. It is better for the time to jump once at startup, rather
    //  than be off by days, for days at a time.
    if (lastTime && offset) {
        if (time < lastTime) {
            let diff = systemTime - lastBaseTime;
            if (diff >= 0) {
                // Some time passed, so we have a baseline for how much to increase the time by.
                //  This allows the real time to catch up with our time naturally.
                time = lastTime + diff * MINIMUM_TIME_RATE;
            } else {
                // The issue is the system time going backwards. In this case, allow the time to change
            }
        }
    }
    lastTime = time;
    lastBaseTime = systemTime;
    return time;
}
export function getTrueTimeOffset() {
    const { offset } = getTimeComponents();
    return offset;
}
export type TrueTimeProof = {
    systemTime: number;
    // The tween endpoints the current offset is moving between. When offset !== toOffset we are still converging.
    fromOffset: number;
    toOffset: number;
    fromTime: number;
    toTime: number;
    offset: number;
    // The raw measurement that produced the newest offset. Undefined if the offset came from a caller-provided base that only returns numbers.
    measurement?: TimeOffsetProof;
};
export function getTrueTimeProof(): TrueTimeProof | undefined {
    const data = cachedTimeOffsetData;
    if (!data) return undefined;
    const detailed = getTimeComponentsDetailed();
    return {
        systemTime: detailed.systemTime,
        fromOffset: detailed.fromOffset,
        toOffset: detailed.toOffset,
        fromTime: detailed.fromTime,
        toTime: detailed.toTime,
        offset: computeTweenedOffset(detailed),
        measurement: data.proof,
    };
}
export function waitForFirstTimeSync(): Promise<void> | undefined {
    if (didFirstTimeSync) return undefined;
    return firstTimeSyncPromise;
}
declare global {
    var TRUE_TIME_ALREADY_SHIMMED: boolean;
}
let shimmed = false;
export function shimDateNow() {
    if (shimmed) return;
    shimmed = true;
    if (globalThis.TRUE_TIME_ALREADY_SHIMMED) return;
    globalThis.TRUE_TIME_ALREADY_SHIMMED = true;
    Date.now = getTrueTime;
}
export function getBrowserTime() {
    return baseGetTime();
}

export function setGetTimeOffsetBase(base: () => Promise<number | TimeOffsetMeasurement>) {
    getTimeOffsetBase = base;
}

function makeMeasurement(sendTime: number, receiveTime: number, serverTime: number): TimeOffsetMeasurement {
    const predictedServerToClientLatency = (receiveTime - sendTime) / 2;
    const offset = serverTime + predictedServerToClientLatency - receiveTime;
    return { offset, proof: { sendTime, receiveTime, serverTime, offset } };
}

async function defaultGetTimeOffset(): Promise<TimeOffsetMeasurement> {
    if (!isNode()) {
        let sendTime = baseGetTime();
        let serverTrueTime = await TimeController.nodes[SocketFunction.browserNodeId()].getTrueTime();
        let receiveTime = baseGetTime();
        return makeMeasurement(sendTime, receiveTime, serverTrueTime);
    }

    const dgram = await import("dgram");
    const NTP_SERVER = "time.google.com";
    const NTP_PORT = 123;
    const NTP_PACKET_SIZE = 48;
    const NTP_EPOCH_OFFSET = 2208988800000; // Number of milliseconds between 1900-01-01 and 1970-01-01
    return new Promise((resolve, reject) => {
        const client = dgram.createSocket("udp4");
        const message = Buffer.alloc(NTP_PACKET_SIZE);

        // Set the first byte to represent NTP client request (LI = 0, VN = 3, Mode = 3)
        message[0] = 0x1B;

        const sendTime = baseGetTime();

        // NTP is UDP, so a lost packet means the "message" event simply never fires. Without a timeout that leaves updateTimeOffset stuck (updatingOffset stays true forever), permanently stopping all future syncs.
        const timeout = setTimeout(() => {
            client.close();
            reject(new Error(`NTP request to ${NTP_SERVER} timed out`));
        }, NTP_TIMEOUT);

        client.send(message, 0, message.length, NTP_PORT, NTP_SERVER);
        client.on("error", (err) => {
            clearTimeout(timeout);
            client.close();
            reject(err);
        });

        client.on("message", (msg) => {
            const receiveTime = baseGetTime();
            // A throw in this handler would be an uncaught exception, not a rejection, so validate before reading fixed offsets.
            if (msg.length < NTP_PACKET_SIZE) return;
            clearTimeout(timeout);

            // Extract the transmit timestamp from the server response
            const transmitTimestampSeconds = msg.readUInt32BE(40);
            const transmitTimestampFraction = msg.readUInt32BE(44);
            const transmitTimestamp = (transmitTimestampSeconds * 1000) + (transmitTimestampFraction * 1000 / 0x100000000) - NTP_EPOCH_OFFSET;

            client.close();
            resolve(makeMeasurement(sendTime, receiveTime, transmitTimestamp));
        });
    });
}

function isValidTimeOffsetData(data: unknown): data is TimeOffsetData {
    const d = data as TimeOffsetData | undefined;
    return (
        !!d &&
        typeof d.lastOffset === "number" &&
        typeof d.lastUpdateTime === "number" &&
        typeof d.offset === "number" &&
        typeof d.updateTime === "number" &&
        typeof d.nextOffset === "number" &&
        typeof d.nextUpdateTime === "number"
    );
}

type TimeOffsetStoreEntry = {
    data: TimeOffsetData;
    version: number;
};
type TimeOffsetStore = {
    getEntry(): Promise<TimeOffsetStoreEntry | undefined>;
    // Atomic conditional write, only succeeds if the stored version matches expectedVersion.
    putIfVersion(data: TimeOffsetData, expectedVersion: number): Promise<boolean>;
    // Unconditional write when no entry exists yet. Returns false if another writer raced us, in which case the caller should re-read and use their data.
    putInitial(data: TimeOffsetData): Promise<boolean>;
};

type TimeOffsetDb = import("lmdb").RootDatabase<TimeOffsetData, string>;
let timeOffsetDb: TimeOffsetDb | undefined = undefined;
let timeOffsetDbPath: string | undefined = undefined;

async function openTimeOffsetDb(): Promise<TimeOffsetDb | undefined> {
    try {
        const lmdb = await import("lmdb");
        const path = await import("path");
        const os = await import("os");

        timeOffsetDbPath = path.join(os.tmpdir(), "socket-function-time-offset-2");
        return lmdb.open<TimeOffsetData, string>({
            path: timeOffsetDbPath,
            // Enable versioning for conditional writes
            useVersions: true,
        });
    } catch (e) {
        console.error("Error opening LMDB database:", (e as Error).stack ?? e);
        return undefined;
    }
}

async function getTimeOffsetDb() {
    if (!USE_LMDB_PROCESS_SYNC) return undefined;
    if (!isNode()) return undefined;
    if (timeOffsetDb) return timeOffsetDb;
    timeOffsetDb = await openTimeOffsetDb();
    return timeOffsetDb;
}

// Closes the current handle (so the next op reopens a fresh one) and, when wipe is set, deletes the
//  on-disk files so a corrupt database is replaced with an empty one. lmdb writes the main file at
//  the path plus a sibling lock file, so we clear the path and its lock variants.
async function recreateTimeOffsetDb(config: { wipe: boolean }) {
    let db = timeOffsetDb;
    timeOffsetDb = undefined;
    if (db) {
        try {
            await db.close();
        } catch (e) {
            console.error("Error closing LMDB database:", (e as Error).stack ?? e);
        }
    }
    if (config.wipe && timeOffsetDbPath) {
        try {
            const fs = await import("fs");
            for (let suffix of ["", "-lock", ".lock"]) {
                await fs.promises.rm(timeOffsetDbPath + suffix, { recursive: true, force: true });
            }
            console.log(yellow(`Wiped corrupt time-offset LMDB database at ${timeOffsetDbPath}`));
        } catch (e) {
            console.error("Error wiping corrupt LMDB database:", (e as Error).stack ?? e);
        }
    }
}

// A corrupt database throws on every read and on the read-back inside every write, and we can't
//  repair it. So we run each op through here: on success we reset the failure count, and on error
//  we reopen the handle (wiping the files once we've hit the threshold) and return the fallback so
//  callers degrade to running unsynced instead of throwing. Ops are serialized by updatingOffset,
//  so there is no concurrent access to worry about.
let lmdbCorruptionFailures = 0;
async function runLmdbOp<T>(name: string, op: (db: TimeOffsetDb) => Promise<T>, fallback: T): Promise<T> {
    const db = await getTimeOffsetDb();
    if (!db) return fallback;
    try {
        const result = await op(db);
        lmdbCorruptionFailures = 0;
        return result;
    } catch (e) {
        lmdbCorruptionFailures++;
        console.error(`Error during LMDB ${name} (failure ${lmdbCorruptionFailures}/${LMDB_MAX_CORRUPTION_FAILURES}):`, (e as Error).stack ?? e);
        let wipe = lmdbCorruptionFailures >= LMDB_MAX_CORRUPTION_FAILURES;
        await recreateTimeOffsetDb({ wipe });
        if (wipe) lmdbCorruptionFailures = 0;
        return fallback;
    }
}

function getLmdbStore(): TimeOffsetStore {
    return {
        async getEntry() {
            return runLmdbOp("getEntry", async (db) => {
                const entry = await db.getEntry("timeOffset"); // Gets {value, version} atomically
                if (!entry) return undefined;
                if (typeof entry.version !== "number" || !isValidTimeOffsetData(entry.value)) return undefined;
                return { data: entry.value, version: entry.version };
            }, undefined);
        },
        async putIfVersion(data, expectedVersion) {
            return runLmdbOp("putIfVersion", async (db) => {
                // Use random version to minimize collision probability on retries
                const newVersion = Math.random();
                const success = await db.ifVersion("timeOffset", expectedVersion, () => {
                    return db.put("timeOffset", data, newVersion);
                });
                return success !== undefined;
            }, false);
        },
        async putInitial(data) {
            return runLmdbOp("putInitial", async (db) => {
                const newVersion = Math.random();
                await db.put("timeOffset", data, newVersion);
                // Read back to see what actually got written
                const actualEntry = await db.getEntry("timeOffset");
                return actualEntry?.version === newVersion;
            }, false);
        },
    };
}

function getLocalStorageStore(): TimeOffsetStore | undefined {
    try {
        if (typeof localStorage === "undefined") return undefined;
    } catch {
        return undefined;
    }
    type StoredValue = {
        version: number;
        data: TimeOffsetData;
    };
    function readStored(): StoredValue | undefined {
        try {
            const raw = localStorage.getItem(TIME_OFFSET_LOCAL_STORAGE_KEY);
            if (!raw) return undefined;
            const parsed = JSON.parse(raw) as StoredValue;
            if (!parsed || typeof parsed.version !== "number" || !isValidTimeOffsetData(parsed.data)) return undefined;
            return parsed;
        } catch (e) {
            console.error("Error reading time offset from localStorage:", (e as Error).stack ?? e);
            return undefined;
        }
    }
    function writeStored(data: TimeOffsetData): number | undefined {
        try {
            const version = Math.random();
            localStorage.setItem(TIME_OFFSET_LOCAL_STORAGE_KEY, JSON.stringify({ version, data }));
            return version;
        } catch (e) {
            console.error("Error writing time offset to localStorage:", (e as Error).stack ?? e);
            return undefined;
        }
    }
    return {
        async getEntry() {
            const stored = readStored();
            if (!stored) return undefined;
            return { data: stored.data, version: stored.version };
        },
        // localStorage has no atomic compare-and-swap, but access within a tab is synchronous, so re-reading the version immediately before writing shrinks the race window to effectively nothing. Worst case two tabs both fetch an offset, which is harmless.
        async putIfVersion(data, expectedVersion) {
            const stored = readStored();
            if (stored?.version !== expectedVersion) return false;
            return writeStored(data) !== undefined;
        },
        async putInitial(data) {
            const version = writeStored(data);
            if (version === undefined) return false;
            return readStored()?.version === version;
        },
    };
}

let timeOffsetStore: TimeOffsetStore | undefined = undefined;
let timeOffsetStoreResolved = false;
async function getTimeOffsetStore(): Promise<TimeOffsetStore | undefined> {
    if (timeOffsetStoreResolved) return timeOffsetStore;
    if (isNode()) {
        const db = await getTimeOffsetDb();
        if (db) {
            timeOffsetStore = getLmdbStore();
        }
    } else {
        timeOffsetStore = getLocalStorageStore();
    }
    timeOffsetStoreResolved = true;
    return timeOffsetStore;
}

let getTimeOffsetBase: () => Promise<number | TimeOffsetMeasurement> = defaultGetTimeOffset;

// Returns undefined if we couldn't get any measurements. Callers must NOT treat that as an offset of 0 - a fabricated offset written to the shared store would poison every other process/tab for the full transition window.
async function fetchNewOffset(): Promise<TimeOffsetMeasurement | undefined> {
    let measurements: TimeOffsetMeasurement[] = [];
    let failures = 0;
    let retryDelay = FETCH_RETRY_INITIAL_DELAY;
    while (measurements.length < UPDATE_VERIFY_COUNT) {
        // The tab may have been hidden mid-fetch. Measurements from a throttled tab are worse than none, so stop and use whatever we already collected.
        if (!canMeasureOffset()) break;
        try {
            const result = await getTimeOffsetBase();
            measurements.push(typeof result === "number" ? { offset: result } : result);
        } catch (e) {
            console.error("Error getting time offset:", (e as Error).stack ?? e);
            failures++;
            if (failures >= FETCH_MAX_FAILURES) break;
            await new Promise(resolve => setTimeout(resolve, retryDelay));
            retryDelay = Math.min(retryDelay * 2, FETCH_RETRY_MAX_DELAY);
        }
    }

    if (measurements.length === 0) {
        return undefined;
    }

    // Pick the middle offset
    measurements.sort((a, b) => a.offset - b.offset);
    let measurement = measurements[Math.floor(measurements.length / 2)];
    let offset = measurement.offset;

    // Log if offset is significant
    let offsetRound = Math.abs(Math.round(offset));
    let offsetColored = (
        Math.abs(offset) > 600 && red(offsetRound + "ms")
        || Math.abs(offset) > 300 && yellow(offsetRound + "ms")
        || green(offsetRound + "ms")
    );
    if (Math.abs(offset) > 500) {
        console.log(`${blue("Synchronized time")}, local clock was ${offset > 0 ? "behind" : "ahead"} by ${offsetColored} @ ${blue(Date.now() + "")}`);
    }

    return measurement;
}

function canMeasureOffset() {
    if (isNode()) return true;
    if (typeof document === "undefined") return true;
    // Hidden tabs get their timers and message delivery throttled, which corrupts the round-trip latency estimate and therefore the offset. A visible tab will measure and share via localStorage instead.
    return document.visibilityState !== "hidden";
}

let updatingOffset = false;
async function updateTimeOffset() {
    if (updatingOffset) return;
    updatingOffset = true;

    try {
        const store = await getTimeOffsetStore();
        if (!store) {
            // IMPORTANT: Always use baseGetTime() for scheduling, never getTrueTime().
            // Our update schedule must be based on the stable system clock, not the
            // offset-adjusted time which changes as we synchronize.
            const currentTime = baseGetTime();
            let cachedData = cachedTimeOffsetData;
            if (cachedData && currentTime >= cachedData.nextUpdateTime) {
                // Past the end - reset and reinitialize
                cachedData = undefined;
                debugLog("Past nextUpdateTime, resetting");
            }

            const needsFetch = !cachedData || currentTime >= cachedData.updateTime;
            if (needsFetch && !canMeasureOffset()) {
                // Keep using whatever offset we have (even a stale one is better than a measurement skewed by background throttling).
            } else if (!cachedData) {
                // First time initialization
                const measurement = await fetchNewOffset();
                if (measurement) {
                    // Re-read the time, as fetchNewOffset can take minutes when it has to retry.
                    const initTime = baseGetTime();
                    const offset = measurement.offset;
                    cachedTimeOffsetData = {
                        lastOffset: offset,
                        lastUpdateTime: initTime,
                        offset: offset,
                        updateTime: initTime + UPDATE_TRANSITION_GAP,
                        nextOffset: offset,
                        nextUpdateTime: initTime + UPDATE_TRANSITION_GAP * 2,
                        proof: measurement.proof,
                    };
                    debugLog("Initialized - time offset:", offset, "ms, next update in", UPDATE_TRANSITION_GAP, "ms");
                }
                // On total failure we leave the data unset (getTrueTime then uses the raw system clock) and the next check interval retries. We never fabricate an offset.
            } else if (currentTime >= cachedData.updateTime) {
                // Time to rotate
                const newMeasurement = await fetchNewOffset();
                if (newMeasurement) {
                    cachedTimeOffsetData = {
                        lastOffset: cachedData.offset,
                        lastUpdateTime: cachedData.updateTime,
                        offset: cachedData.nextOffset,
                        updateTime: cachedData.nextUpdateTime,
                        nextOffset: newMeasurement.offset,
                        nextUpdateTime: cachedData.nextUpdateTime + UPDATE_TRANSITION_GAP,
                        proof: newMeasurement.proof,
                    };
                    const timeUntilNext = cachedTimeOffsetData.nextUpdateTime - baseGetTime();
                    debugLog("Advancing time offset - current:", cachedTimeOffsetData.offset, "ms, next:", cachedTimeOffsetData.nextOffset, "ms, next update in", timeUntilNext, "ms");
                }
            }

            // Always resolve the first sync, even on failure - SocketFunction.mount awaits this, and hanging forever is worse than temporarily running on the unadjusted system clock.
            markFirstTimeSync();
            return;
        }

        // At this point we have a shared store (LMDB for processes, localStorage for tabs) with atomic-ish versioned writes.
        while (true) {
            const entry = await store.getEntry();
            // IMPORTANT: Always use baseGetTime() for scheduling, never getTrueTime().
            // Our update schedule must be based on the stable system clock, not the
            // offset-adjusted time which changes as we synchronize.
            const currentTime = baseGetTime();

            let cachedData = entry?.data;
            const readVersion = entry?.version;

            if (cachedData && currentTime >= cachedData.nextUpdateTime) {
                // Past the end - reset and reinitialize
                cachedData = undefined;
                debugLog("Past nextUpdateTime, resetting");
            }

            const needsFetch = !cachedData || currentTime >= cachedData.updateTime;
            if (needsFetch && !canMeasureOffset()) {
                // Keep using whatever offset we have (even a stale one is better than a measurement skewed by background throttling). If we have nothing, run unsynced until we become visible or another tab writes to the store.
                cachedTimeOffsetData = entry?.data ?? cachedTimeOffsetData;
                break;
            }

            if (!cachedData || !readVersion) {
                // First time initialization - use conditional write to handle race
                const measurement = await fetchNewOffset();
                if (!measurement) {
                    // Total failure - keep any stale data rather than writing a fabricated offset to the shared store. The next check interval retries.
                    cachedTimeOffsetData = entry?.data ?? cachedTimeOffsetData;
                    break;
                }
                // Re-read the time, as fetchNewOffset can take minutes when it has to retry.
                const initTime = baseGetTime();
                const offset = measurement.offset;
                const initData: TimeOffsetData = {
                    lastOffset: offset,
                    lastUpdateTime: initTime,
                    offset: offset,
                    updateTime: initTime + UPDATE_TRANSITION_GAP,
                    nextOffset: offset,
                    nextUpdateTime: initTime + UPDATE_TRANSITION_GAP * 2,
                    proof: measurement.proof,
                };

                if (readVersion) {
                    const success = await store.putIfVersion(initData, readVersion);
                    if (!success) {
                        debugLog("Lost the race, retrying");
                        // Lost the race, retry
                        continue;
                    }
                    cachedTimeOffsetData = initData;
                    console.log("Successfully wrote atomic reset");
                    break;
                }

                if (!await store.putInitial(initData)) {
                    // Lost the race, another writer wrote after us
                    // Retry from the top to read their data
                    debugLog("Value was changed by another process, retrying");
                    continue;
                }

                // We won the race, use our data
                cachedTimeOffsetData = initData;
                debugLog("Initialized - time offset:", offset, "ms, next update in", UPDATE_TRANSITION_GAP, "ms");
                break;
            }

            if (currentTime >= cachedData.updateTime) {
                // Time to rotate
                const newMeasurement = await fetchNewOffset();
                if (!newMeasurement) {
                    // Total failure - keep the existing data unrotated (the offset just flattens out at nextOffset). The next check interval retries the rotation.
                    cachedTimeOffsetData = cachedData;
                    break;
                }
                const newData: TimeOffsetData = {
                    lastOffset: cachedData.offset,
                    lastUpdateTime: cachedData.updateTime,
                    offset: cachedData.nextOffset,
                    updateTime: cachedData.nextUpdateTime,
                    nextOffset: newMeasurement.offset,
                    nextUpdateTime: cachedData.nextUpdateTime + UPDATE_TRANSITION_GAP,
                    proof: newMeasurement.proof,
                };

                const success = await store.putIfVersion(newData, readVersion);
                if (!success) {
                    // Lost the race, retry
                    continue;
                }

                const timeUntilNext = newData.nextUpdateTime - baseGetTime();
                debugLog("Advancing time offset - current:", newData.offset, "ms, next:", newData.nextOffset, "ms, next update in", timeUntilNext, "ms");
                cachedTimeOffsetData = newData;
                break;
            } else {
                cachedTimeOffsetData = cachedData;
                const timeUntilNext = cachedData.updateTime - baseGetTime();
                debugLog("Loaded from store - current:", cachedData.offset, "ms, next:", cachedData.nextOffset, "ms, next update in", timeUntilNext, "ms");
                break;
            }
        }

        markFirstTimeSync();
    } finally {
        updatingOffset = false;
    }
}

function triggerUpdateTimeOffset() {
    updateTimeOffset().catch((e) => {
        console.warn("Error updating time offset:", e);
    });
}

setInterval(triggerUpdateTimeOffset, UPDATE_CHECK_INTERVAL);
setImmediate(() => {
    updateTimeOffset().catch((e) => {
        console.error("Error updating initial offset:", e);
    });
});

if (!isNode() && typeof window !== "undefined" && typeof document !== "undefined") {
    // If we loaded in a hidden tab we skip measuring, so re-check as soon as we become visible.
    document.addEventListener("visibilitychange", triggerUpdateTimeOffset);
    window.addEventListener("focus", triggerUpdateTimeOffset);
    // Pick up offsets other tabs write, so only one tab ever has to measure.
    window.addEventListener("storage", (e) => {
        if (e.key === TIME_OFFSET_LOCAL_STORAGE_KEY) {
            triggerUpdateTimeOffset();
        }
    });
}


class TimeControllerBase {
    public async getTrueTime() {
        await waitForFirstTimeSync();
        return getTrueTime();
    }
}

const TimeController = SocketFunction.register(
    "TimeController-ddf4753e-fc8a-413f-8cc2-b927dd449976",
    new TimeControllerBase(),
    () => ({
        getTrueTime: {
            // No hooks, as this needs to run very early on. Also, it is basically just a ping,
            //  so it should be safe for anyone to use (we might even make it just a regular HTTPS endpoint,
            //  or even just set up a dedicated domain for this).
            noDefaultHooks: true,
            noClientHooks: true,
        },
    }),
    () => ({}),
    {
        // NOTE: Autoexpose, because our exposed endpoints are incredibly lightweight
        //  (just a ping), and don't expose really expose any data.
        // noAutoExpose: true
    }
);
