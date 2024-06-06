import { SocketFunction } from "../SocketFunction";
import { isNode } from "../src/misc";

module.allowclient = true;

const UPDATE_INTERVAL = 1000 * 60 * 10;
// More frequent, to ensure we don't run into major issues with sleep (coming back from sleep,
//  having the interval not be fired immediately, and having the time be off for a few minutes).
const UPDATE_SUB_INTERVAL = 1000 * 10;
// Smearing is important, otherwise some performance timing (especially on load) can easily be off
//  by a few hundred milliseconds. The current smear parameters will mean even with 1s of offset
//  we only add 10ms every 100ms, so worst case scenario some timing that takes 0ms will take 10ms.
const UPDATE_SMEAR_TICK_DURATION = 100;
const UPDATE_SMEAR_TICK_COUNT = 100;
const UPDATE_VERIFY_COUNT = 3;

let trueTimeOffset = 0;
let didFirstTimeSync = false;
let onFirstTimeSync!: () => void;
let firstTimeSyncPromise = new Promise<void>((resolve) => {
    onFirstTimeSync = resolve;
});

const baseGetTime = Date.now;
export function getTrueTime() {
    return baseGetTime() + trueTimeOffset;
}
export function getTrueTimeOffset() {
    return trueTimeOffset;
}
export function waitForFirstTimeSync() {
    return firstTimeSyncPromise;
}
export function shimDateNow() {
    Date.now = getTrueTime;
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

let getTimeOffsetBase: () => Promise<number> = defaultGetTimeOffset;
let updatingOffset = false;
async function updateTimeOffset() {
    if (updatingOffset) return;
    updatingOffset = true;
    try {
        let offsets: number[] = [];
        for (let i = 0; i < UPDATE_VERIFY_COUNT; i++) {
            try {
                offsets.push(await getTimeOffsetBase());
            } catch (e) {
                console.error("Error getting time offset:", e);
            }
        }
        // If we have no offsets, it likely means every call errored out (probably because the network is down).
        //  This is fine, just don't update (DO register the first sync as being done, otherwise calling code
        //  might be waiting forever).
        if (offsets.length > 0) {
            // Pick the middle offset
            offsets.sort((a, b) => a - b);
            let offset = offsets[Math.floor(offsets.length / 2)];

            // Smear it slowly
            let currentSmearCount = UPDATE_SMEAR_TICK_COUNT;
            // Update the initial time all at once, otherwise initial requests to other servers might
            //  be rejected (because they could use the system time, which could be off by a few seconds).
            if (!didFirstTimeSync) {
                currentSmearCount = 1;
            }

            let prevOffset = trueTimeOffset;
            for (let i = 0; i < currentSmearCount; i++) {
                let fraction = (i + 1) / currentSmearCount;
                trueTimeOffset = prevOffset * (1 - fraction) + offset * fraction;
                if (i < currentSmearCount - 1) {
                    await new Promise((resolve) => setTimeout(resolve, UPDATE_SMEAR_TICK_DURATION));
                }
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

let nextUpdateTime = 0;
setInterval(() => {
    if (baseGetTime() < nextUpdateTime) return;
    nextUpdateTime = baseGetTime() + UPDATE_INTERVAL;
    updateTimeOffset().catch((e) => {
        console.warn("Error updating time offset:", e);
    });
}, UPDATE_SUB_INTERVAL);
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
        getTrueTime: {},
    }),
    () => ({
    }),
    {
        // NOTE: Autoexpose, because our exposed endpoints are incredibly lightweight
        //  (just a ping), and don't expose really expose any data.
        // noAutoExpose: true
    }
);