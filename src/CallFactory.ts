import { CallerContext, CallerContextBase, CallType, FullCallType } from "../SocketFunctionTypes";
import * as ws from "ws";
import { getCallFlags, performLocalCall, shouldCompressCall } from "./callManager";
import { convertErrorStackToError, formatNumberSuffixed, isBufferType, isNode, list, timeInHour, timeInMinute } from "./misc";
import { createWebsocketFactory, getTLSSocket } from "./websocketFactory";
import { SocketFunction } from "../SocketFunction";
import * as tls from "tls";
import { changeNodeId, getClientNodeId, getNodeIdLocation, registerNodeClient } from "./nodeCache";
import debugbreak from "debugbreak";
import { lazy } from "./caching";
import { blue, green, red, yellow } from "./formatting/logColors";
import { isSplitableArray, markArrayAsSplitable } from "./fixLargeNetworkCalls";
import { delay, runInfinitePoll, runInSerial } from "./batching";
import { formatNumber, formatTime } from "./formatting/format";
import zlib from "zlib";
import pako from "pako";
import { setFlag } from "../require/compileFlags";
import { measureFnc, measureWrap, registerMeasureInfo } from "./profiling/measure";
import { MaybePromise } from "./types";
import { Zip } from "./Zip";
import { LZ4 } from "./lz4/LZ4";

setFlag(require, "pako", "allowclient", true);

// NOTE: If it is too low, and too many servers disconnect, we can easily spend 100% of our time
//  trying to reconnect.
//  (Or... maybe the delay is just waiting, and we aren't actually overloading the server?)
const MIN_RETRY_DELAY = 5000;

type InternalCallType = FullCallType & {
    seqNum: number;
    isReturn: false;
    isArgsCompressed?: boolean | "LZ4" | "zip";
}

type InternalReturnType = {
    isReturn: true;
    result: unknown;
    error?: string;
    seqNum: number;
    isResultCompressed?: boolean | "LZ4" | "zip";
};


export interface CallFactory {
    nodeId: string;
    realNodeId?: string;
    lastClosed: number;
    closedForever?: boolean;
    isConnected?: boolean;
    receivedInitializeState?: InitializeState;
    // NOTE: May or may not have reconnection or retry logic inside of performCall.
    //  Trigger performLocalCall on the other side of the connection
    performCall(call: CallType): Promise<unknown>;
    onNextDisconnect(callback: () => void): void;
    disconnect(): void;
    // If we change the node ID we need to recreate this object, essentially this object should be immutable. I forget why we wanted this. I think it's because we didn't know for sure if node ID would be unique, but it will be. 
    connectionId: { nodeId: string };
}

export interface SenderInterface {
    nodeId?: string;
    // Only set AFTER "open" (if set at all, as in the browser we don't have access to the socket).
    _socket?: tls.TLSSocket;

    send(data: string | Buffer): void;
    close(): void;

    addEventListener(event: "open", listener: () => void): void;
    addEventListener(event: "close", listener: () => void): void;
    addEventListener(event: "error", listener: (err: { message: string }) => void): void;
    addEventListener(event: "message", listener: (data: ws.RawData | ws.MessageEvent | string) => void): void;

    readyState: number;

    ping?(): void;
}

type InitializeState = {
    supportsLZ4?: boolean;
};

const INITIALIZE_STATE_SEQ_NUM = -1;

let pendingCallCount = 0;
let harvestableFailedCalls = 0;
const CALL_TIMES_LIMIT = 1000 * 1000 * 10;
let harvestableCallTimes: { start: number; end: number; }[] = [];
export function harvestFailedCallCount() {
    let count = harvestableFailedCalls;
    harvestableFailedCalls = 0;
    return count;
}
export function getPendingCallCount() {
    return pendingCallCount;
}
export function harvestCallTimes() {
    let times = harvestableCallTimes;
    harvestableCallTimes = [];
    return times;
}
runInfinitePoll(timeInMinute * 15, () => {
    if (harvestableCallTimes.length > CALL_TIMES_LIMIT) {
        harvestableCallTimes = harvestableCallTimes.slice(-CALL_TIMES_LIMIT);
    }
});


export async function createCallFactory(
    webSocketBase: SenderInterface | undefined,
    // The node id we are connecting to (or that connected to us)
    nodeId: string,
    // The node id that we were contacted on
    localNodeId = "",
): Promise<CallFactory> {
    let niceConnectionName = nodeId;

    const createWebsocket = createWebsocketFactory();
    const registerOnce = lazy(() => registerNodeClient(callFactory));

    let canReconnect = !!getNodeIdLocation(nodeId);

    let pendingCalls: Map<number, {
        data: Buffer[];
        call: InternalCallType;
        callback: (resultJSON: InternalReturnType) => void;
    }> = new Map();
    // NOTE: It is important to make this as random as possible, to prevent
    //  reconnections dues to a process being reset causing seqNum collisions
    //  in return calls.
    let nextSeqNum = Date.now() + Math.random();

    // NOTE: I'm not sure if this is needed, I thought it was, but... now I think
    //  it probably isn't...
    // if (webSocketBase?.readyState === 1 /* OPEN */ && webSocketBase.ping) {
    //     // Heartbeat loop, otherwise onDisconnect is never called.
    //     ((async () => {
    //         while (webSocketBase?.readyState === 1 /* OPEN */ && webSocketBase.ping) {
    //             await delay(1000 * 60);
    //             webSocketBase.ping?.();
    //         }
    //     }))().catch(() => { });
    // }

    let lastConnectionAttempt = 0;

    let callerContext: CallerContextBase = {
        nodeId,
        localNodeId
    };

    let disconnectCallbacks = new Set<() => void>();
    function onNextDisconnect(callback: () => void): void {
        disconnectCallbacks.add(callback);
    }

    let callFactory: CallFactory = {
        nodeId,
        lastClosed: 0,
        connectionId: { nodeId },
        receivedInitializeState: undefined,
        onNextDisconnect,
        disconnect() {
            canReconnect = false;
            callFactory.closedForever = true;
            if (webSocketPromise) {
                webSocketPromise.then(ws => ws.close()).catch(() => { });
            }
        },
        async performCall(call: CallType) {
            let seqNum = nextSeqNum++;
            let fullCall: InternalCallType = {
                nodeId,
                isReturn: false,
                args: call.args,
                classGuid: call.classGuid,
                functionName: call.functionName,
                seqNum,
            };
            let data: Buffer[];
            let originalArgs = call.args;
            let time = Date.now();
            let sendStats: CompressionStats = {
                uncompressedSize: 0,
                compressedSize: 0,
            };
            try {
                if (callFactory.receivedInitializeState?.supportsLZ4) {
                    let compressMode = shouldCompressCall(fullCall);
                    // If it's undefined, then we compress it. We basically always want to compress from now on, because LZ4 is so fast. 
                    if (compressMode !== false) {
                        fullCall.args = await compressObjLZ4(fullCall.args, sendStats) as any;
                        fullCall.isArgsCompressed = "LZ4";
                    }
                } else {
                    if (shouldCompressCall(fullCall)) {
                        fullCall.args = await compressObj(fullCall.args, sendStats) as any;
                        fullCall.isArgsCompressed = "zip";
                    }
                }
                let dataMaybePromise = SocketFunction.WIRE_SERIALIZER.serialize(fullCall);
                if (dataMaybePromise instanceof Promise) {
                    data = await dataMaybePromise;
                } else {
                    data = dataMaybePromise;
                }
                if (!sendStats.compressedSize) {
                    let totalSize = 0;
                    for (let d of data) {
                        totalSize += d.length;
                    }
                    sendStats.uncompressedSize = totalSize;
                    sendStats.compressedSize = totalSize;
                }
                addSendStats(sendStats);
            } catch (e: any) {
                throw new Error(`Error serializing data for call ${call.classGuid}.${call.functionName}\n${e.stack}`);
            }
            time = Date.now() - time;
            let size = data.map(x => x.length).reduce((a, b) => a + b, 0);
            if (time > SocketFunction.WIRE_WARN_TIME) {
                console.log(red(`Slow serialize, took ${formatTime(time)} to serialize ${formatNumber(size)} bytes. For ${call.classGuid}.${call.functionName}`));
            }

            if (size > SocketFunction.MAX_MESSAGE_SIZE * 1.5) {
                let splitArgIndex = originalArgs.findIndex(isSplitableArray);
                if (splitArgIndex >= 0) {
                    console.log(yellow(`Splitting large call due to large args: ${call.classGuid}.${call.functionName}`));
                    let SPLIT_GROUPS = 10;
                    let splitArg = originalArgs[splitArgIndex] as unknown[];
                    let subCalls = list(SPLIT_GROUPS).map(index => {
                        let start = Math.floor(index / SPLIT_GROUPS * splitArg.length);
                        let end = Math.floor((index + 1) / SPLIT_GROUPS * splitArg.length);
                        return splitArg.slice(start, end);
                    }).filter(x => x.length > 0);

                    let calls = subCalls.map(async splitList => {
                        let subCall = { ...call };
                        subCall.args = subCall.args.slice();
                        subCall.args[splitArgIndex] = markArrayAsSplitable(splitList);
                        await callFactory.performCall(subCall);
                    });
                    await Promise.allSettled(calls);
                    await Promise.all(calls);
                    // Eh... we COULD return the array of results, but... then the result would sometimes be an array,
                    //  some times not, so, it is better to return a string which will make it more clear why it sometimes varies.
                    return "CALLS_SPLIT_DUE_TO_LARGE_ARGS";
                }

                throw new Error(`Call too large to send (${call.classGuid}.${call.functionName}, size: ${formatNumber(size)} > ${formatNumber(SocketFunction.MAX_MESSAGE_SIZE)}). If you need to handle very large static data use some external service, such as Backblaze B2 or AWS S3. Or consider fragmenting data at an application level, because sending large data will cause large lag spikes for other clients using this server. Or, if absolutely required, set SocketFunction.MAX_MESSAGE_SIZE to a higher value.`);
            }

            let resultPromise = new Promise((resolve, reject) => {
                let startTime = Date.now();
                pendingCallCount++;
                let callback = (result: InternalReturnType) => {
                    pendingCallCount--;
                    pendingCalls.delete(seqNum);
                    harvestableCallTimes.push({ start: startTime, end: Date.now(), });

                    if (result.error) {
                        reject(convertErrorStackToError(result.error));
                    } else {
                        resolve(result.result);
                    }
                };
                pendingCalls.set(seqNum, { callback, data, call: fullCall });
            });

            {
                let resultSize = data.map(x => x.length).reduce((a, b) => a + b, 0);
                for (let callback of SocketFunction.trackMessageSizes.upload) {
                    callback(resultSize);
                }
                if (SocketFunction.logMessages) {
                    let fncHack = "";
                    if (call.functionName === "addCall") {
                        let arg = originalArgs[0] as any;
                        fncHack = `.${arg.DomainName}.${arg.ModuleId}.${arg.FunctionId}`;
                    }
                    console.log(`SIZE\t${(formatNumberSuffixed(resultSize) + `B`).padEnd(4, " ")}\t${formatNumber(data.length)} buffers\tREMOTE CALL\t${call.classGuid}.${call.functionName}${fncHack} at ${Date.now()}`);
                }
            }
            // If sending OR resultPromise throws, we want to error out. This solves some issues with resultPromise
            //      erroring out first, which is before we await it, which makes NodeJS angry (unhandled promise rejection).
            //      Also, technically, we could receive the result before we finish sending, in which case, we might
            //      as well return it immediately.
            await Promise.race([send(data), resultPromise]);
            return await resultPromise;
        }
    };

    let webSocketPromise: Promise<SenderInterface> | undefined;
    let hasEverConnected = false;
    if (webSocketBase) {
        webSocketPromise = Promise.resolve(webSocketBase);
        await initializeWebsocket(webSocketBase);
    }

    async function initializeWebsocket(newWebSocket: SenderInterface, skipCloseHandling = false) {
        registerOnce();
        callFactory.receivedInitializeState = undefined;

        function onClose(error: string) {
            // We try various connections, and if they fail, we will just try other node IDs until we finally do connect, and then we stick with that nodeId, and when it disconnects we need to handle disconnections normally.
            if (skipCloseHandling && !hasEverConnected) {
                return;
            }

            callFactory.connectionId = { nodeId };
            callFactory.lastClosed = Date.now();
            callFactory.isConnected = false;
            webSocketPromise = undefined;
            if (!canReconnect) {
                callFactory.closedForever = true;
            }
            for (let [key, call] of pendingCalls) {
                harvestableFailedCalls++;
                pendingCalls.delete(key);
                call.callback({
                    isReturn: true,
                    result: undefined,
                    error: error,
                    seqNum: call.call.seqNum,
                });
            }

            let callbacks = disconnectCallbacks;
            disconnectCallbacks = new Set();
            for (let callback of callbacks) {
                try {
                    callback();
                } catch { }
            }
        }

        newWebSocket.addEventListener("error", e => {
            // NOTE: No more logging, as we throw, so the caller should be logging the
            //  error (or swallowing it, if that is what it wants to do).
            //console.log(`Websocket error for ${niceConnectionName}`, e.message);
            onClose(new Error(`Connection error for ${niceConnectionName}: ${e.message}`).stack!);
        });

        newWebSocket.addEventListener("close", async () => {
            //console.log(`Websocket closed ${niceConnectionName}`);
            onClose(new Error(`Connection closed to ${niceConnectionName}`).stack!);
        });

        newWebSocket.addEventListener("message", onMessage);


        if (newWebSocket.readyState === 0 /* CONNECTING */) {
            await new Promise<void>(resolve => {
                newWebSocket.addEventListener("open", () => {
                    if (!SocketFunction.silent) {
                        console.log(`Connection established to ${niceConnectionName}`);
                    }
                    callFactory.isConnected = true;
                    hasEverConnected = true;
                    resolve();
                });
                newWebSocket.addEventListener("close", () => resolve());
                newWebSocket.addEventListener("error", () => resolve());
            });
        } else if (newWebSocket.readyState === 1 /* OPEN */) {
            callFactory.isConnected = true;
            hasEverConnected = true;
        } else {
            onClose(new Error(`Websocket received in closed state`).stack!);
        }
    }

    const BASE_LENGTH_OFFSET = 324_432_461_592_612;
    type MessageHeader = {
        type: "serialized";
        bufferCount: number;
    } | {
        type: "Buffer[]" | "Buffer";
        bufferCount: number;
        bufferLengths?: number[];
        metadata: Omit<InternalReturnType, "result">;
    };
    let sendInSerial = runInSerial(async (val: () => Promise<void>) => val());
    async function sendRaw(data: (string | Buffer)[]) {
        if (!webSocketPromise) {
            if (canReconnect) {
                webSocketPromise = tryToReconnect();
            } else {
                throw new Error(`Cannot send data to ${niceConnectionName} as the connection has closed`);
            }
        }
        let webSocket = await webSocketPromise;
        await sendInSerial(async () => {
            for (let d of data) {
                if (d.length > 1000 * 1000 * 10) {
                    console.log(`Sending large packet ${formatNumber(d.length)}B to ${nodeId} at ${Date.now()}`);
                }

                // NOTE: If our latency is 500ms, with 10MB/s, then we need a high water
                //  mark of at least 5MB, otherwise our connection is slowed down.
                //  - Using the actual high water mark is too difficult, as we receive incoming connections.
                //      This is also easier to configure, and we can dynamically change it if we have to.
                // NOTE: In practice we only hit this when sending large Buffers (~30MB), so low values
                //  are equivalent to waiting for drain. We want to avoid waiting for drain, so we use a high value.
                const maxWriteBuffer = 128 * 1024 * 1024;
                webSocket.send(d);

                let socket = webSocket._socket;
                if (socket) {
                    while (socket.writableLength > maxWriteBuffer) {
                        // NOTE: Waiting 1ms probably waits more like 16ms.
                        await new Promise(r => setTimeout(r, 1));
                    }
                }
            }
        });
    }
    async function send(data: Buffer[]) {
        await sendRaw([
            (data.length + BASE_LENGTH_OFFSET).toString(),
            ...data,
        ]);
    }
    async function sendWithHeader(data: Buffer[], header: MessageHeader) {
        if (data.some(x => x.length > SocketFunction.MAX_MESSAGE_SIZE * 1.5)) {
            if (header.type === "Buffer" || header.type === "Buffer[]") {
                header.bufferLengths = data.map(x => x.length);
                let fitBuffers: Buffer[] = [];
                for (let buf of data) {
                    if (buf.length > SocketFunction.MAX_MESSAGE_SIZE) {
                        let offset = 0;
                        while (offset < buf.length) {
                            fitBuffers.push(buf.slice(offset, offset + SocketFunction.MAX_MESSAGE_SIZE));
                            offset += SocketFunction.MAX_MESSAGE_SIZE;
                        }
                    } else {
                        fitBuffers.push(buf);
                    }
                }
                data = fitBuffers;
                header.bufferCount = fitBuffers.length;
            } else {
                throw new Error(`Cannot send large amounts of data unless we are returning Buffer or Buffer[]`);
            }
        }
        // if (totalResultSize > SocketFunction.MAX_MESSAGE_SIZE * 1.5) {
        // Split up Buffer[] if they are too large
        await sendRaw([
            JSON.stringify(header),
            ...data,
        ]);
    }
    async function tryToReconnect(): Promise<SenderInterface> {
        // Don't try to reconnect too often!
        let timeSinceLastAttempt = Date.now() - lastConnectionAttempt;
        if (timeSinceLastAttempt < MIN_RETRY_DELAY) {
            await new Promise(r => setTimeout(r, MIN_RETRY_DELAY - timeSinceLastAttempt));
        }
        lastConnectionAttempt = Date.now();

        // Try alternates, and if any work, use them
        try {
            let alternates = await SocketFunction.GET_ALTERNATE_NODE_IDS(nodeId);
            if (alternates) {
                for (let alternateNodeId of alternates) {
                    let newWebSocket = createWebsocket(alternateNodeId);
                    await initializeWebsocket(newWebSocket, true);

                    if (callFactory.isConnected) {
                        return newWebSocket;
                    }
                }
            }
        } catch (e) {
            console.error("Error getting alternate node IDs", e);
        }

        let newWebSocket = createWebsocket(nodeId);
        await initializeWebsocket(newWebSocket);

        return newWebSocket;
    }

    let pendingCall: MessageHeader & {
        buffers: Buffer[];
        firstReceivedTime?: number;
    } | undefined;

    async function processPendingCall() {
        if (!pendingCall) throw new Error(`No pending call`);
        let currentCall = pendingCall;
        pendingCall = undefined;
        let currentBuffers = currentCall.buffers;
        let call: InternalCallType | InternalReturnType;
        let resultSize: number;
        let time = Date.now();
        if (currentCall.type === "Buffer" || currentCall.type === "Buffer[]") {
            let result: Buffer | Buffer[] = currentBuffers;
            if (currentCall.bufferLengths) {
                let pendingBuffers = currentBuffers;
                function takeBuffer(len: number) {
                    let lenLeft = len;
                    let buffers: Buffer[] = [];
                    while (lenLeft > 0) {
                        let buf = currentBuffers.shift();
                        if (!buf) {
                            throw new Error(`Not enough buffers received.`);
                        }
                        if (buf.length > lenLeft) {
                            buffers.push(buf.slice(0, lenLeft));
                            currentBuffers.unshift(buf.slice(lenLeft));
                            break;
                        } else {
                            buffers.push(buf);
                            lenLeft -= buf.length;
                        }
                    }
                    if (buffers.length === 1) {
                        return buffers[0];
                    }
                    return Buffer.concat(buffers);
                }
                result = currentCall.bufferLengths.map(takeBuffer);
                if (pendingBuffers.length > 0) {
                    throw new Error(`Received too many buffers.`);
                }
            }
            resultSize = result.map(x => x.length).reduce((a, b) => a + b, 0);
            if (currentCall.type === "Buffer") {
                if (result.length === 1) {
                    result = result[0];
                } else {
                    result = Buffer.concat(result);
                }
            }
            call = {
                ...currentCall.metadata,
                result,
            };
        } else {
            resultSize = currentBuffers.map(x => x.length).reduce((a, b) => a + b, 0);
            call = await SocketFunction.WIRE_SERIALIZER.deserialize(currentBuffers) as InternalCallType | InternalReturnType;
        }
        let parseTime = Date.now() - time;
        for (let callback of SocketFunction.trackMessageSizes.download) {
            callback(resultSize);
        }

        let receiveStats: CompressionStats = {
            uncompressedSize: resultSize,
            compressedSize: resultSize,
        };
        let sendStats: CompressionStats = {
            uncompressedSize: 0,
            compressedSize: 0,
        };

        if (call.isReturn) {
            if (!SocketFunction.LEGACY_INITIALIZE && call.seqNum === INITIALIZE_STATE_SEQ_NUM) {
                callFactory.receivedInitializeState = call.result as InitializeState;
                if (SocketFunction.logMessages) {
                    console.log(green(`Received initialize state from ${callFactory.realNodeId} (for ${nodeId}) at ${Date.now()}`));
                }
                return;
            }
            let callbackObj = pendingCalls.get(call.seqNum);
            if (parseTime > SocketFunction.WIRE_WARN_TIME) {
                console.log(red(`Slow parse, took ${parseTime}ms to parse ${resultSize} bytes, for receiving result of call to ${callbackObj?.call.classGuid}.${callbackObj?.call.functionName}`));
            }
            if (!callbackObj) {
                console.log(blue(`Got return for unknown call ${call.seqNum} (created at time ${new Date(call.seqNum)}), ${nodeId} / ${localNodeId}`));
                return;
            }
            if (SocketFunction.logMessages) {
                let call = callbackObj.call;
                console.log(`SIZE\t${(formatNumberSuffixed(resultSize) + "B").padEnd(4, " ")}\t${formatNumber(currentBuffers.length)} buffers\tRETURN\t${call.classGuid}.${call.functionName} at ${Date.now()}, (${nodeId} / ${localNodeId})`);
            }
            if (call.isResultCompressed === "LZ4") {
                call.result = await decompressObjLZ4(call.result as Buffer[], receiveStats);
                call.isResultCompressed = undefined;
            } else if (call.isResultCompressed === "zip" || call.isResultCompressed === true) {
                call.result = await decompressObj(call.result as Buffer, receiveStats);
                call.isResultCompressed = undefined;
            }
            callbackObj.callback(call);
        } else {
            if (call.isArgsCompressed === "LZ4") {
                call.args = await decompressObjLZ4(call.args as any as Buffer[], sendStats) as any;
                call.isArgsCompressed = undefined;
            } else if (call.isArgsCompressed === "zip" || call.isArgsCompressed === true) {
                call.args = await decompressObj(call.args as any as Buffer, sendStats) as any;
                call.isArgsCompressed = undefined;
            }
            if (SocketFunction.logMessages) {
                console.log(`SIZE\t${(formatNumberSuffixed(resultSize) + "B").padEnd(4, " ")}\tEVALUATE\t${call.classGuid}.${call.functionName} at ${Date.now()}, (${nodeId} / ${localNodeId})`);
            }
            if (parseTime > SocketFunction.WIRE_WARN_TIME) {
                console.log(red(`Slow parse, took ${parseTime}ms to parse ${resultSize} bytes, for call to ${call.classGuid}.${call.functionName}`));
            }

            let response: InternalReturnType;
            try {
                SocketFunction.TOTAL_CALLS++;
                let result = await performLocalCall({ call, caller: callerContext });
                response = {
                    isReturn: true,
                    result,
                    seqNum: call.seqNum,
                };
                if (SocketFunction.logMessages) {
                    let timeTaken = Date.now() - time;
                    console.log(`DUR\t${(formatTime(timeTaken)).padEnd(6, " ")}\tFINISH\t${call.classGuid}.${call.functionName} at ${Date.now()}, (${nodeId} / ${localNodeId})`);
                }
                if (callFactory.receivedInitializeState?.supportsLZ4) {
                    let compressMode = shouldCompressCall(call);
                    if (compressMode !== false) {
                        response.result = await compressObjLZ4(response.result, sendStats);
                        response.isResultCompressed = "LZ4";
                    }
                } else {
                    if (shouldCompressCall(call)) {
                        response.result = await compressObj(response.result, sendStats);
                        response.isResultCompressed = "zip";
                    }
                }
            } catch (e: any) {
                response = {
                    isReturn: true,
                    result: undefined,
                    seqNum: call.seqNum,
                    error: e.stack,
                };
            }
            {
                let start = time;
                let end = Date.now();
                for (let fnc of SocketFunction.trackMessageSizes.callTimes) {
                    fnc({ start, end });
                }
            }

            let size = 0;

            if (response.result instanceof Buffer) {
                let { result, ...remaining } = response;
                size = result.length;
                await sendWithHeader([result], { type: "Buffer", bufferCount: 1, metadata: remaining });
            } else if (Array.isArray(response.result) && response.result.every(x => x instanceof Buffer)) {
                let { result, ...remaining } = response;
                for (let r of result) {
                    size += r.length;
                }
                await sendWithHeader(result, { type: "Buffer[]", bufferCount: result.length, metadata: remaining });
            } else {
                const LIMIT = getCallFlags(call)?.responseLimit || SocketFunction.MAX_MESSAGE_SIZE * 1.5;
                let result: Buffer[] = await SocketFunction.WIRE_SERIALIZER.serialize(response);
                let totalResultSize = result.map(x => x.length).reduce((a, b) => a + b, 0);
                if (totalResultSize > LIMIT) {
                    response = {
                        isReturn: true,
                        result: undefined,
                        seqNum: call.seqNum,
                        error: new Error(`Response too large to send. Return Buffer[] to exceed the limits, or set responseLimit when registering the collection. ${call.classGuid}.${call.functionName}, size: ${formatNumber(totalResultSize)} > ${formatNumber(SocketFunction.MAX_MESSAGE_SIZE)}. If you need to handle very large static data use some external service, such as Backblaze B2 or AWS S3. Or, if absolutely required, set SocketFunction.MAX_MESSAGE_SIZE to a higher value.`).stack,
                    };
                    result = await SocketFunction.WIRE_SERIALIZER.serialize(response);
                }
                for (let r of result) {
                    size += r.length;
                }
                await send(result);
            }

            // If we have no size, then it's probably uncompressed
            if (!sendStats.compressedSize) {
                sendStats.compressedSize = size;
                sendStats.uncompressedSize = size;
            }
        }

        addSendStats(sendStats);
        addReceiveStats(receiveStats);
    }

    let clientsideSerial = runInSerial(async <T>(val: Promise<T>) => val);
    async function onMessage(message: ws.RawData | ws.MessageEvent | string) {
        try {
            if (typeof message === "object" && "data" in message) {
                message = message.data;
            }
            // Extra clienside parsing is required
            if (!isNode()) {
                // Immediately start the arrayBuffer conversion. This should be fast, but...
                //  maybe we will add more here, and so doing it in parallel might be useful.
                let fixMessageBlob = (async () => {
                    if (message instanceof Blob) {
                        message = Buffer.from(await message.arrayBuffer());
                    }
                })();
                // We need to force the results to be in serial, otherwise strings leapfrog
                //  ahead of buffers, which breaks things.
                await clientsideSerial(fixMessageBlob);
            }
            if (typeof message === "string") {
                if (message.startsWith("{")) {
                    let obj = JSON.parse(message);
                    pendingCall = {
                        ...obj,
                        buffers: [],
                    };
                } else {
                    let count = parseInt(message);
                    if (isNaN(count)) {
                        throw new Error(`Invalid message count ${message}`);
                    }
                    if (count < BASE_LENGTH_OFFSET) {
                        throw new Error(`Invalid message count ${message}`);
                    }
                    count -= BASE_LENGTH_OFFSET;
                    if (count > 1000 * 1000) {
                        throw new Error(`Invalid message count ${count}`);
                    }
                    pendingCall = {
                        buffers: [],
                        bufferCount: count,
                        type: "serialized",
                    };
                }
                if (pendingCall?.bufferCount === 0) {
                    await processPendingCall();
                }
                return;
            }
            if (message instanceof Buffer) {
                if (!pendingCall) {
                    throw new Error(`Received data without size ${message.byteLength}B, first 100 bytes: ${message.slice(0, 100).toString("hex")}`);
                }
                let totalSize = message.byteLength + pendingCall.buffers.reduce((a, b) => a + b.length, 0);
                if (totalSize > 1000 * 1000 * 10 || pendingCall.bufferCount > 1000 && (pendingCall.buffers.length % 100 === 0)) {
                    if (pendingCall.buffers.length === 0) {
                        console.log(`Received large/many packets ${formatNumber(totalSize)}B (${pendingCall.buffers.length} / ${pendingCall.bufferCount}) at ${Date.now()}`);
                    } else {
                        let elapsed = Date.now() - (pendingCall.firstReceivedTime || 0);
                        console.log(`Received large/many packets ${formatNumber(totalSize)}B (${pendingCall.buffers.length} / ${pendingCall.bufferCount}) after ${formatTime(elapsed)}`);
                    }
                }
                if (pendingCall.buffers.length === 0) {
                    pendingCall.firstReceivedTime = Date.now();
                }
                pendingCall.buffers.push(message);
                if (pendingCall.buffers.length !== pendingCall.bufferCount) {
                    return;
                }

                await processPendingCall();
                return;
            }
            throw new Error(`Unhandled data type ${typeof message}`);
        } catch (e: any) {
            let err = e.stack || e.message || e;
            // NOTE: I'm looking for all types of errors here (specifically, .send errors), in case
            //  there are errors I should be handling.
            if (err.startsWith("Error: Cannot send data to") && err.includes("as the connection has closed")) {
                // This is fine, just ignore it
            } else if (err.includes("The requested file could not be read, typically due to permission problems that have occurred after a reference to a file was acquired.")) {
                console.error(`WebSocket data was dropped by the browser due to exceeding the Blob limit. Either you are about to run out of memory, or you hit the much lower Incognito Blob limit. This will likely break the application. To reset the memory you must close all tabs of this site. This is a bug/feature in chrome.`);
            } else {
                console.error(e.stack);
            }
        }
    }


    if (!SocketFunction.LEGACY_INITIALIZE) {
        let initState: InitializeState = {
            supportsLZ4: true,
        };
        let initReturn: InternalReturnType = {
            isReturn: true,
            result: initState,
            seqNum: INITIALIZE_STATE_SEQ_NUM,
        };
        if (SocketFunction.logMessages) {
            console.log(`Sending initialize state to ${nodeId}`);
        }
        let data = await SocketFunction.WIRE_SERIALIZER.serialize(initReturn);
        await send(data);
        if (SocketFunction.logMessages) {
            console.log(`Sent initialize state to ${nodeId}`);
        }
    }

    return callFactory;
}


let uncompressedSent = 0;
let compressedSent = 0;
let uncompressedReceived = 0;
let compressedReceived = 0;

let sendCount = 0;
let receiveCount = 0;

function addSendStats(stats: CompressionStats) {
    uncompressedSent += stats.uncompressedSize;
    compressedSent += stats.compressedSize;
    sendCount++;
}
function addReceiveStats(stats: CompressionStats) {
    uncompressedReceived += stats.uncompressedSize;
    compressedReceived += stats.compressedSize;
    receiveCount++;
}
// Register this late as I don't want it to appear before the memory register info, which is use more useful than the network one. 
setImmediate(() => {
    registerMeasureInfo(() => `NET => ${formatNumber(compressedSent)}B (${formatNumber(uncompressedSent)}B/${formatNumber(sendCount)}) / <= ${formatNumber(compressedReceived)}B (${formatNumber(uncompressedReceived)}B/${formatNumber(receiveCount)})`);
});

type CompressionStats = {
    uncompressedSize: number;
    compressedSize: number;
};

const compressObj = measureWrap(async function wireCallCompress(obj: unknown, stats: CompressionStats): Promise<Buffer> {
    let buffers = await SocketFunction.WIRE_SERIALIZER.serialize(obj);
    if (buffers.length > 1) {
        throw new Error("Legacy CompressObj only supports single buffer");
    }
    let lengthBuffer = Buffer.from((new Float64Array(buffers.map(x => x.length))).buffer);
    let buffer = Buffer.concat([lengthBuffer, ...buffers]);
    stats.uncompressedSize += buffer.length;
    let result = await Zip.gzip(buffer);
    stats.compressedSize += result.length;
    return result;
});
// Assumes the caller already added the obj.length to both the uncompressedSize and compressedSize, and is just looking to update the uncompressedSize to be larger according to the size after we uncompress
const decompressObj = measureWrap(async function wireCallDecompress(obj: Buffer, stats: CompressionStats): Promise<unknown> {
    let buffer = await Zip.gunzip(obj);
    stats.uncompressedSize += buffer.length - obj.length;
    let lengthBuffer = buffer.slice(0, 8);
    let lengths = new Float64Array(lengthBuffer.buffer, lengthBuffer.byteOffset, lengthBuffer.byteLength / 8);
    let buffers: Buffer[] = [];
    let offset = 8;
    for (let length of lengths) {
        buffers.push(buffer.slice(offset, offset + length));
        offset += length;
    }
    let result = await SocketFunction.WIRE_SERIALIZER.deserialize(buffers);
    return result;
});

const compressObjLZ4 = measureWrap(async function wireCallCompressLZ4(obj: unknown, stats: CompressionStats): Promise<Buffer[]> {
    let headerParts: number[];
    let dataBuffers: Buffer[];

    if (obj instanceof Buffer) {
        headerParts = [1];
        dataBuffers = [obj];
    } else if (Array.isArray(obj) && obj.every((x: any) => x instanceof Buffer)) {
        let bufferArray = obj as Buffer[];
        const TARGET_SIZE = 50 * 1024 * 1024;
        const MIN_INDIVIDUAL_SIZE = 10 * 1024 * 1024;
        const MAX_UNSPLIT_SIZE = 100 * 1024 * 1024;

        let outputBuffers: Buffer[] = [];
        let outputDescriptors: number[][] = [];
        let currentGroup: Buffer[] = [];
        let currentGroupSize = 0;

        function flushCurrentGroup() {
            if (currentGroup.length > 0) {
                outputBuffers.push(Buffer.concat(currentGroup));
                outputDescriptors.push(currentGroup.map(b => b.length));
                currentGroup = [];
                currentGroupSize = 0;
            }
        }

        for (let buf of bufferArray) {
            if (buf.length >= MIN_INDIVIDUAL_SIZE) {
                flushCurrentGroup();

                if (buf.length > MAX_UNSPLIT_SIZE) {
                    let offset = 0;
                    while (offset < buf.length) {
                        let chunkSize = Math.min(TARGET_SIZE, buf.length - offset);
                        outputBuffers.push(buf.slice(offset, offset + chunkSize));
                        outputDescriptors.push([chunkSize]);
                        offset += chunkSize;
                    }
                } else {
                    outputBuffers.push(buf);
                    outputDescriptors.push([buf.length]);
                }
            } else {
                currentGroup.push(buf);
                currentGroupSize += buf.length;

                if (currentGroupSize >= TARGET_SIZE) {
                    flushCurrentGroup();
                }
            }
        }

        flushCurrentGroup();

        headerParts = [2, outputBuffers.length];
        for (let descriptor of outputDescriptors) {
            headerParts.push(descriptor.length, ...descriptor);
        }
        dataBuffers = outputBuffers;
    } else {
        let buffers = await SocketFunction.WIRE_SERIALIZER.serialize(obj);
        headerParts = [3, buffers.length];
        dataBuffers = buffers;
    }

    let headerBuffer = Buffer.from((new Float64Array(headerParts)).buffer);
    let allBuffers = [headerBuffer, ...dataBuffers];

    stats.uncompressedSize += allBuffers.reduce((sum, buf) => sum + buf.length, 0);

    let compressed: Buffer[] = [];
    let startTime = Date.now();
    let lastWarnTime = startTime;
    let currentUncompressedSize = 0;
    let currentCompressedSize = 0;

    function logIfSlow(i: number) {
        let now = Date.now();
        if (now - lastWarnTime > 500) {
            let elapsed = now - startTime;
            console.log(`Slow LZ4 compress (${formatTime(elapsed)}: ${i + 1}/${allBuffers.length} buffers, ${formatNumber(currentUncompressedSize)}B => ${formatNumber(currentCompressedSize)}B`);
            lastWarnTime = now;
        }
    }

    for (let i = 0; i < allBuffers.length; i++) {
        let buf = allBuffers[i];
        currentUncompressedSize += buf.length;
        let compressedBuf = LZ4.compress(buf);
        compressed.push(compressedBuf);
        currentCompressedSize += compressedBuf.length;

        logIfSlow(i);
    }
    logIfSlow(allBuffers.length);

    stats.compressedSize += currentCompressedSize;

    return compressed;
});

const decompressObjLZ4 = measureWrap(async function wireCallDecompressLZ4(obj: Buffer[], stats: CompressionStats): Promise<unknown> {
    stats.compressedSize += obj.reduce((sum, buf) => sum + buf.length, 0);

    let decompressed: Buffer[] = [];
    let startTime = Date.now();
    let lastWarnTime = startTime;
    let currentCompressedSize = 0;
    let currentUncompressedSize = 0;
    function logIfSlow(i: number) {
        let now = Date.now();
        if (now - lastWarnTime > 500) {
            let elapsed = now - startTime;
            console.log(`Slow LZ4 decompress (${formatTime(elapsed)}): ${i + 1}/${obj.length} buffers, ${formatNumber(currentCompressedSize)}B => ${formatNumber(currentUncompressedSize)}B`);
            lastWarnTime = now;
        }
    }

    for (let i = 0; i < obj.length; i++) {
        let buf = obj[i];
        currentCompressedSize += buf.length;
        let decompressedBuf = LZ4.decompress(buf);
        decompressed.push(decompressedBuf);
        currentUncompressedSize += decompressedBuf.length;

        logIfSlow(i);
    }
    logIfSlow(obj.length);

    stats.uncompressedSize += currentUncompressedSize;

    let headerBuffer = decompressed[0];
    let dataBuffers = decompressed.slice(1);

    let typeBuffer = headerBuffer.slice(0, 8);
    let type = new Float64Array(typeBuffer.buffer, typeBuffer.byteOffset, 1)[0];

    if (type === 1) {
        return dataBuffers[0];
    }

    if (type === 2) {
        let headerData = new Float64Array(headerBuffer.buffer, headerBuffer.byteOffset, headerBuffer.byteLength / 8);
        let outputBufferCount = headerData[1];

        let buffers: Buffer[] = [];
        let headerIndex = 2;

        for (let i = 0; i < outputBufferCount; i++) {
            let inputBufferCount = headerData[headerIndex++];
            let sizes: number[] = [];
            for (let j = 0; j < inputBufferCount; j++) {
                sizes.push(headerData[headerIndex++]);
            }

            let outputBuffer = dataBuffers[i];
            let offset = 0;
            for (let size of sizes) {
                buffers.push(outputBuffer.slice(offset, offset + size));
                offset += size;
            }
        }

        return buffers;
    }

    if (type === 3) {
        let result = await SocketFunction.WIRE_SERIALIZER.deserialize(dataBuffers);
        return result;
    }

    throw new Error(`Unknown compression type ${type}`);
});