import { SocketFunction } from "../SocketFunction";
import { blue, green, red, yellow } from "../src/formatting/logColors";
import { isNode } from "../src/misc";

// IMPOTRANT! We don't ensure that the times of return are unique. We cannot ensure they are unique because the amount of precision is only about ten thousand date times per millisecond, Which would mean if the calling code called date.now frequently enough, which doesn't even have to be that frequent, it could slowly drift farther and farther ahead of the real time, which would be really bad.

module.allowclient = true;


const UPDATE_VERIFY_COUNT = 3;

// Configuration for cross-process synchronization
const UPDATE_TRANSITION_GAP = 1000 * 60 * 20; // 5 minutes between current and next
const UPDATE_CHECK_INTERVAL = 1000 * 60 * 5; // Check every 1 minute
const DEBUG_TIME_SYNC = false; // Enable debug logging for time synchronization

// Time can never go backwards, but we can run at a slower rate until the output time allows
//      the real time to catch up with it.
const MINIMUM_TIME_RATE = 0.5;

const THROW_ON_ERROR = false;

// Hugely important as if we don't synchronize between processes, it means our logs are going to be confusing and out of order. 
//  - Of course, cross-machine, the logs could be out of order. However, due to the latency between machines, that's less likely. The latency will probably be a few milliseconds, and hopefully, our time isn't more than a few milliseconds off of the real time. However, between processes, the latency could easily be microseconds, and our time will absolutely certainly be microseconds off of the real time. 
let USE_LMDB_PROCESS_SYNC = true;

function debugLog(...args: any[]) {
    if (DEBUG_TIME_SYNC) {
        console.log("[TimeSync]", ...args);
    }
}

type TimeOffsetData = {
    lastOffset: number;
    lastUpdateTime: number;
    offset: number;
    updateTime: number;
    nextOffset: number;
    nextUpdateTime: number;
};

let cachedTimeOffsetData: TimeOffsetData | undefined = undefined;
let didFirstTimeSync = false;
let onFirstTimeSync!: () => void;
let firstTimeSyncPromise = new Promise<void>((resolve) => {
    onFirstTimeSync = resolve;
});

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

export function getTimeComponents(): { systemTime: number; offset: number } {
    const detailed = getTimeComponentsDetailed();
    const elapsed = detailed.systemTime - detailed.fromTime;
    const duration = detailed.toTime - detailed.fromTime;
    const fraction = duration > 0 ? Math.min(1, elapsed / duration) : 0;
    const offset = detailed.fromOffset + (detailed.toOffset - detailed.fromOffset) * fraction;
    return { systemTime: detailed.systemTime, offset };
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

export function setGetTimeOffsetBase(base: () => Promise<number>) {
    getTimeOffsetBase = base;
}

async function defaultGetTimeOffset(): Promise<number> {
    if (!isNode()) {
        let sendTime = baseGetTime();
        let serverTrueTime = await TimeController.nodes[SocketFunction.browserNodeId()].getTrueTime();
        let systemTime = baseGetTime();
        let predictedServerToClientLatency = (systemTime - sendTime) / 2;
        let trueTimeRightNow = serverTrueTime + predictedServerToClientLatency;
        return trueTimeRightNow - systemTime;
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

        client.send(message, 0, message.length, NTP_PORT, NTP_SERVER);
        client.on("error", (err) => {
            client.close();
            reject(err);
        });

        client.on("message", (msg) => {
            const receiveTime = baseGetTime();

            // Extract the transmit timestamp from the server response
            const transmitTimestampSeconds = msg.readUInt32BE(40);
            const transmitTimestampFraction = msg.readUInt32BE(44);
            const transmitTimestamp = (transmitTimestampSeconds * 1000) + (transmitTimestampFraction * 1000 / 0x100000000) - NTP_EPOCH_OFFSET;

            const predictedServerToClientLatency = (receiveTime - sendTime) / 2;

            // Calculate the offset
            const systemTime = baseGetTime();
            const actualTime = transmitTimestamp + predictedServerToClientLatency;
            const offset = actualTime - systemTime;

            client.close();
            resolve(offset);
        });
    });
}

let timeOffsetDb: import("lmdb").RootDatabase<TimeOffsetData, string> | undefined = undefined;
async function getTimeOffsetDb() {
    if (!USE_LMDB_PROCESS_SYNC) return undefined;
    if (timeOffsetDb) return timeOffsetDb;
    if (!isNode()) return undefined;

    try {
        const lmdb = await import("lmdb");
        const path = await import("path");
        const os = await import("os");

        const dbPath = path.join(os.tmpdir(), "socket-function-time-offset-2");
        timeOffsetDb = lmdb.open<TimeOffsetData, string>({
            path: dbPath,
            // Enable versioning for conditional writes
            useVersions: true,
        });
        return timeOffsetDb;
    } catch (e) {
        console.error("Error opening LMDB database:", e);
        return undefined;
    }
}

async function getTimeOffsetFromLmdb(): Promise<{
    data: TimeOffsetData;
    version: number;
} | undefined> {
    if (!isNode() || !USE_LMDB_PROCESS_SYNC) {
        // Skip LMDB for browsers or if disabled
        return undefined;
    }

    try {
        const db = await getTimeOffsetDb();
        if (!db) return undefined;

        const entry = await db.getEntry("timeOffset"); // Gets {value, version} atomically
        if (!entry) return undefined;

        const data = entry.value;
        const version = entry.version;

        if (data &&
            typeof version === "number" &&
            typeof data.lastOffset === "number" &&
            typeof data.lastUpdateTime === "number" &&
            typeof data.offset === "number" &&
            typeof data.updateTime === "number" &&
            typeof data.nextOffset === "number" &&
            typeof data.nextUpdateTime === "number") {
            return { data, version };
        }
        return undefined;
    } catch (e) {
        console.error("Error reading from LMDB database:", e);
        return undefined;
    }
}

async function setTimeOffsetInLmdb(
    data: TimeOffsetData,
    expectedVersion: number
): Promise<boolean> {
    try {
        const db = await getTimeOffsetDb();
        if (!db) return false;

        // Atomic conditional write - only succeeds if version matches expectedVersion
        // Use random version to minimize collision probability on retries
        const newVersion = Math.random();

        // Conditional write with version check
        const success = await db.ifVersion("timeOffset", expectedVersion, () => {
            return db.put("timeOffset", data, newVersion);
        });

        return success !== undefined;
    } catch (e) {
        console.error("Error writing to LMDB database:", e);
        return false;
    }
}

let getTimeOffsetBase: () => Promise<number> = defaultGetTimeOffset;

async function fetchNewOffset(): Promise<number> {
    let offsets: number[] = [];
    for (let i = 0; i < UPDATE_VERIFY_COUNT; i++) {
        try {
            offsets.push(await getTimeOffsetBase());
        } catch (e) {
            console.error("Error getting time offset:", e);
        }
    }

    if (offsets.length === 0) {
        // All calls failed, return 0 as fallback
        return 0;
    }

    // Pick the middle offset
    offsets.sort((a, b) => a - b);
    let offset = offsets[Math.floor(offsets.length / 2)];

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

    return offset;
}

let updatingOffset = false;
async function updateTimeOffset() {
    if (updatingOffset) return;
    updatingOffset = true;

    try {
        const db = await getTimeOffsetDb();
        if (!db) {
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

            if (!cachedData) {
                // First time initialization
                const offset = await fetchNewOffset();
                cachedTimeOffsetData = {
                    lastOffset: offset,
                    lastUpdateTime: currentTime,
                    offset: offset,
                    updateTime: currentTime + UPDATE_TRANSITION_GAP,
                    nextOffset: offset,
                    nextUpdateTime: currentTime + UPDATE_TRANSITION_GAP * 2,
                };
                debugLog("Initialized - time offset:", offset, "ms, next update in", UPDATE_TRANSITION_GAP, "ms");
            } else if (currentTime >= cachedData.updateTime) {
                // Time to rotate
                const newOffset = await fetchNewOffset();
                cachedTimeOffsetData = {
                    lastOffset: cachedData.offset,
                    lastUpdateTime: cachedData.updateTime,
                    offset: cachedData.nextOffset,
                    updateTime: cachedData.nextUpdateTime,
                    nextOffset: newOffset,
                    nextUpdateTime: cachedData.nextUpdateTime + UPDATE_TRANSITION_GAP,
                };
                const timeUntilNext = cachedTimeOffsetData.nextUpdateTime - baseGetTime();
                debugLog("Advancing time offset - current:", cachedTimeOffsetData.offset, "ms, next:", cachedTimeOffsetData.nextOffset, "ms, next update in", timeUntilNext, "ms");
            }

            if (!didFirstTimeSync) {
                didFirstTimeSync = true;
                onFirstTimeSync();
            }
            return;
        }

        // At this point: Node.js, LMDB enabled and working
        // Main LMDB path with atomic synchronization
        while (true) {
            const entry = await getTimeOffsetFromLmdb();
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

            if (!cachedData || !readVersion) {
                // First time initialization - use conditional write to handle race
                const offset = await fetchNewOffset();
                const initData: TimeOffsetData = {
                    lastOffset: offset,
                    lastUpdateTime: currentTime,
                    offset: offset,
                    updateTime: currentTime + UPDATE_TRANSITION_GAP,
                    nextOffset: offset,
                    nextUpdateTime: currentTime + UPDATE_TRANSITION_GAP * 2,
                };

                const newVersion = Math.random();

                if (readVersion) {
                    const success = await setTimeOffsetInLmdb(initData, readVersion);
                    if (!success) {
                        debugLog("Lost the race, retrying");
                        // Lost the race, retry
                        continue;
                    }
                    console.log("Successfully wrote atomic reset");
                    break;
                }

                // Try to write our data
                await db.put("timeOffset", initData, newVersion);

                // Read back to see what actually got written
                const actualEntry = await db.getEntry("timeOffset");
                if (actualEntry?.version !== newVersion) {
                    // Lost the race, another process wrote after us
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
                const newOffset = await fetchNewOffset();
                const newData: TimeOffsetData = {
                    lastOffset: cachedData.offset,
                    lastUpdateTime: cachedData.updateTime,
                    offset: cachedData.nextOffset,
                    updateTime: cachedData.nextUpdateTime,
                    nextOffset: newOffset,
                    nextUpdateTime: cachedData.nextUpdateTime + UPDATE_TRANSITION_GAP,
                };

                const success = await setTimeOffsetInLmdb(newData, readVersion);
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
                debugLog("Loaded from LMDB - current:", cachedData.offset, "ms, next:", cachedData.nextOffset, "ms, next update in", timeUntilNext, "ms");
                break;
            }
        }

        if (!didFirstTimeSync) {
            didFirstTimeSync = true;
            onFirstTimeSync();
        }
    } finally {
        updatingOffset = false;
    }
}

setInterval(() => {
    updateTimeOffset().catch((e) => {
        console.warn("Error updating time offset:", e);
    });
}, UPDATE_CHECK_INTERVAL);
setImmediate(() => {
    updateTimeOffset().catch((e) => {
        console.error("Error updating initial offset:", e);
    });
});


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