import { CallerContext, CallerContextBase, CallType, FullCallType } from "../SocketFunctionTypes";
import * as ws from "ws";
import { getCallFlags, performLocalCall, shouldCompressCall } from "./callManager";
import { convertErrorStackToError, formatNumberSuffixed, isBufferType, isNode, list, timeInHour, timeInMinute } from "./misc";
import { createWebsocketFactory, getTLSSocket } from "./websocketFactory";
import { SocketFunction } from "../SocketFunction";
import * as tls from "tls";
import { getClientNodeId, getNodeIdLocation, registerNodeClient } from "./nodeCache";
import debugbreak from "debugbreak";
import { lazy } from "./caching";
import { red, yellow } from "./formatting/logColors";
import { isSplitableArray, markArrayAsSplitable } from "./fixLargeNetworkCalls";
import { delay, runInfinitePoll, runInSerial } from "./batching";
import { formatNumber, formatTime } from "./formatting/format";
import zlib from "zlib";
import pako from "pako";
import { setFlag } from "../require/compileFlags";
import { measureFnc, measureWrap, registerMeasureInfo } from "./profiling/measure";
import { MaybePromise } from "./types";
import { Zip } from "./Zip";
setFlag(require, "pako", "allowclient", true);

// NOTE: If it is too low, and too many servers disconnect, we can easily spend 100% of our time
//  trying to reconnect.
//  (Or... maybe the delay is just waiting, and we aren't actually overloading the server?)
const MIN_RETRY_DELAY = 5000;

type InternalCallType = FullCallType & {
    seqNum: number;
    isReturn: false;
    isArgsCompressed?: boolean;
}

type InternalReturnType = {
    isReturn: true;
    result: unknown;
    error?: string;
    seqNum: number;
    isResultCompressed?: boolean;
};


export interface CallFactory {
    nodeId: string;
    lastClosed: number;
    closedForever?: boolean;
    isConnected?: boolean;
    // NOTE: May or may not have reconnection or retry logic inside of performCall.
    //  Trigger performLocalCall on the other side of the connection
    performCall(call: CallType): Promise<unknown>;
    onNextDisconnect(callback: () => void): void;
    connectionId: { nodeId: string };
}

export interface SenderInterface {
    nodeId?: string;
    // Only set AFTER "open" (if set at all, as in the browser we don't have access to the socket).
    _socket?: tls.TLSSocket;

    send(data: string | Buffer): void;

    addEventListener(event: "open", listener: () => void): void;
    addEventListener(event: "close", listener: () => void): void;
    addEventListener(event: "error", listener: (err: { message: string }) => void): void;
    addEventListener(event: "message", listener: (data: ws.RawData | ws.MessageEvent | string) => void): void;

    readyState: number;

    ping?(): void;
}

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

    const canReconnect = !!getNodeIdLocation(nodeId);

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

    let disconnectCallbacks: (() => void)[] = [];
    function onNextDisconnect(callback: () => void): void {
        disconnectCallbacks.push(callback);
    }

    let callFactory: CallFactory = {
        nodeId,
        lastClosed: 0,
        connectionId: { nodeId },
        onNextDisconnect,
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
                if (shouldCompressCall(fullCall)) {
                    fullCall.args = await compressObj(fullCall.args, sendStats) as any;
                    fullCall.isArgsCompressed = true;
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
                    console.log(`SIZE\t${(formatNumberSuffixed(resultSize) + "B").padEnd(4, " ")}\tREMOTE CALL\t${call.classGuid}.${call.functionName}${fncHack} at ${Date.now()}`);
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
    if (webSocketBase) {
        webSocketPromise = Promise.resolve(webSocketBase);
        await initializeWebsocket(webSocketBase);
    }

    async function initializeWebsocket(newWebSocket: SenderInterface) {
        registerOnce();

        function onClose(error: string) {
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
            disconnectCallbacks = [];
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
                    resolve();
                });
                newWebSocket.addEventListener("close", () => resolve());
                newWebSocket.addEventListener("error", () => resolve());
            });
        } else if (newWebSocket.readyState === 1 /* OPEN */) {
            callFactory.isConnected = true;
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

        let newWebSocket = createWebsocket(nodeId);
        await initializeWebsocket(newWebSocket);

        return newWebSocket;
    }

    let pendingCall: MessageHeader & {
        buffers: Buffer[];
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
            let callbackObj = pendingCalls.get(call.seqNum);
            if (parseTime > SocketFunction.WIRE_WARN_TIME) {
                console.log(red(`Slow parse, took ${parseTime}ms to parse ${resultSize} bytes, for receiving result of call to ${callbackObj?.call.classGuid}.${callbackObj?.call.functionName}`));
            }
            if (!callbackObj) {
                console.log(`Got return for unknown call ${call.seqNum} (created at time ${new Date(call.seqNum)})`);
                return;
            }
            if (SocketFunction.logMessages) {
                let call = callbackObj.call;
                console.log(`SIZE\t${(formatNumberSuffixed(resultSize) + "B").padEnd(4, " ")}\tRETURN\t${call.classGuid}.${call.functionName} at ${Date.now()}, (${nodeId} / ${localNodeId})`);
            }
            if (call.isResultCompressed) {
                call.result = await decompressObj(call.result as Buffer, receiveStats);
                call.isResultCompressed = false;
            }
            callbackObj.callback(call);
        } else {
            if (call.isArgsCompressed) {
                call.args = await decompressObj(call.args as any as Buffer, sendStats) as any;
                call.isArgsCompressed = false;
            }
            if (call.functionName === "changeIdentity") {
                /*
                    TODO: Sometimes calls don't get through, even though we know the client made the call. Here are the logs from a failing case:
                        Exposing Controller ServerController-17ea53da-bbef-4c8b-9eb0-99e263464c6f
                        Exposing Controller HotReloadController-032b2250-3aac-4187-8c95-75412742b8f5
                        Exposing Controller TimeController-ddf4753e-fc8a-413f-8cc2-b927dd449976
                        Updating websocket server options
                        Updating websocket server trusted certificates
                        Updating websocket server options
                        Updating websocket server trusted certificates
                        Updating websocket server options
                        Updating websocket server trusted certificates
                        Trying to listening on 127.0.0.1:4231
                        Started Listening on planquickly.com:4231 (127.0.0.1) after 5.54s
                        Mounted on 127-0-0-1.planquickly.com:4231
                        Exposing Controller RequireController-e2f811f3-14b8-4759-b0d6-73f14516cf1d
                        Received TCP connection from 127.0.0.1:42105
                        Received TCP header packet from 127.0.0.1:42105, have 1894 bytes so far, 1 packets
                        Received TCP connection with SNI "127-0-0-1.planquickly.com". Have handlers for: planquickly.com, 127-0-0-1.planquickly.com
                        HTTP server connection established 127.0.0.1:42105
                        HTTP request (GET) https://127-0-0-1.planquickly.com:4231/?hot
                        HTTP response  106KB  (GET) https://127-0-0-1.planquickly.com:4231/?hot
                        HTTP server socket closed for 127.0.0.1:42105
                        Received TCP connection from 127.0.0.1:42106
                        Received TCP header packet from 127.0.0.1:42106, have 1862 bytes so far, 1 packets
                        Received TCP connection with SNI "127-0-0-1.planquickly.com". Have handlers for: planquickly.com, 127-0-0-1.planquickly.com
                        HTTP server connection established 127.0.0.1:42106
                        HTTP request (GET) https://127-0-0-1.planquickly.com:4231/?classGuid=RequireController-e2f811f3-14b8-4759-b0d6-73f14516cf1d&functionName=getModules&args=%5B%5B%22.%2Fsite%2FsiteMain%22%5D%2Cnull%5D
                        HTTP response  10.8MB  (GET) https://127-0-0-1.planquickly.com:4231/?classGuid=RequireController-e2f811f3-14b8-4759-b0d6-73f14516cf1d&functionName=getModules&args=%5B%5B%22.%2Fsite%2FsiteMain%22%5D%2Cnull%5D
                        Received TCP connection from 127.0.0.1:42107
                        Received TCP header packet from 127.0.0.1:42107, have 1894 bytes so far, 1 packets
                        Received TCP connection with SNI "127-0-0-1.planquickly.com". Have handlers for: planquickly.com, 127-0-0-1.planquickly.com
                        HTTP server connection established 127.0.0.1:42107
                        HTTP server socket closed for 127.0.0.1:42106
                        HTTP server socket closed for 127.0.0.1:42107
                        Received TCP connection from 127.0.0.1:42108
                        Received TCP header packet from 127.0.0.1:42108, have 1830 bytes so far, 1 packets
                        Received TCP connection with SNI "127-0-0-1.planquickly.com". Have handlers for: planquickly.com, 127-0-0-1.planquickly.com
                        HTTP server connection established 127.0.0.1:42108
                        HTTP request (GET) https://127-0-0-1.planquickly.com:4231/node.cjs.map
                        HTTP response  106KB  (GET) https://127-0-0-1.planquickly.com:4231/node.cjs.map
                        HTTP server socket closed for 127.0.0.1:42108
                        Received TCP connection from 127.0.0.1:42110
                        Received TCP header packet from 127.0.0.1:42110, have 1818 bytes so far, 1 packets
                        Received TCP connection with SNI "127-0-0-1.planquickly.com". Have handlers for: planquickly.com, 127-0-0-1.planquickly.com
                        HTTP server connection established 127.0.0.1:42110
                        Received TCP connection from 127.0.0.1:42111
                        Received TCP header packet from 127.0.0.1:42111, have 1830 bytes so far, 1 packets
                        Received TCP connection with SNI "127-0-0-1.planquickly.com". Have handlers for: planquickly.com, 127-0-0-1.planquickly.com
                        HTTP server connection established 127.0.0.1:42111
                        Received websocket upgrade request for 127.0.0.1:42110
                        Connection established to client:127.0.0.1:1744150129862.296:0.4118126921519041
                        HTTP request (GET) https://127-0-0-1.planquickly.com:4231/?classGuid=RequireController-e2f811f3-14b8-4759-b0d6-73f14516cf1d&functionName=getModules&args=%5B%5B%22D%3A%2Frepos%2Fperspectanalytics%2Fai3%2Fnode_modules%2Fsocket-function%2Ftime%2FtrueTimeShim.ts%22%5D%2C%7B%22requireSeqNumProcessId%22%3A%22requireSeqNumProcessId_1744150120269_0.5550074391586426%22%2C%22seqNumRanges%22%3A%5B%7B%22s%22%3A1%2C%22e%22%3A892%7D%5D%7D%5D
                        HTTP response  31.1KB  (GET) https://127-0-0-1.planquickly.com:4231/?classGuid=RequireController-e2f811f3-14b8-4759-b0d6-73f14516cf1d&functionName=getModules&args=%5B%5B%22D%3A%2Frepos%2Fperspectanalytics%2Fai3%2Fnode_modules%2Fsocket-function%2Ftime%2FtrueTimeShim.ts%22%5D%2C%7B%22requireSeqNumProcessId%22%3A%22requireSeqNumProcessId_1744150120269_0.5550074391586426%22%2C%22seqNumRanges%22%3A%5B%7B%22s%22%3A1%2C%22e%22%3A892%7D%5D%7D%5D
                        SIZE    171B    EVALUATE        HotReloadController-032b2250-3aac-4187-8c95-75412742b8f5.watchFiles at 1744150129869.296
                        SIZE    174B    EVALUATE        ServerController-17ea53da-bbef-4c8b-9eb0-99e263464c6f.testSiteFunction at 1744150129872.296
                        HTTP server socket closed for 127.0.0.1:42111
                        SIZE    167B    EVALUATE        TimeController-ddf4753e-fc8a-413f-8cc2-b927dd449976.getTrueTime at 1744150129893.296
                        SIZE    167B    EVALUATE        TimeController-ddf4753e-fc8a-413f-8cc2-b927dd449976.getTrueTime at 1744150129897.296
                        SIZE    167B    EVALUATE        TimeController-ddf4753e-fc8a-413f-8cc2-b927dd449976.getTrueTime at 1744150129899.296
                        SIZE    167B    EVALUATE        TimeController-ddf4753e-fc8a-413f-8cc2-b927dd449976.getTrueTime at 1744150139907.0776
                        SIZE    167B    EVALUATE        TimeController-ddf4753e-fc8a-413f-8cc2-b927dd449976.getTrueTime at 1744150139909.0776
                        SIZE    167B    EVALUATE        TimeController-ddf4753e-fc8a-413f-8cc2-b927dd449976.getTrueTime at 1744150139911.0776
                        Hot reloading due to change: D:/repos/perspectanalytics/ai3/node_modules/socket-function/src/webSocketServer.ts
                    - The upgrade request finishes, at least once: Received websocket upgrade
                        - AND, we are receiving some calls, so... that appears to work.
                        - Maybe the time calls never finish?
                            - We added logging for when calls finish as well, so we can tell if all the TimeController calls timed out
                            - ALSO, added more logging to see if the calls were from the same client (which WOULD be a bug, because
                                the client shouldn't be calling us so often), or, different clients.
                        - We DO receive more connections than http connections closed. But not that many more...
                */
                console.log(red(`Call to ${call.classGuid}.${call.functionName} at ${Date.now()}`));
            }
            if (SocketFunction.logMessages) {
                console.log(`SIZE\t${(formatNumberSuffixed(resultSize) + "B").padEnd(4, " ")}\tEVALUATE\t${call.classGuid}.${call.functionName} at ${Date.now()}, (${nodeId} / ${localNodeId})`);
            }
            if (parseTime > SocketFunction.WIRE_WARN_TIME) {
                console.log(red(`Slow parse, took ${parseTime}ms to parse ${resultSize} bytes, for call to ${call.classGuid}.${call.functionName}`));
            }

            let response: InternalReturnType;
            try {
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
                if (shouldCompressCall(call)) {
                    response.result = await compressObj(response.result, sendStats) as any;
                    response.isResultCompressed = true;
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
                if (message.byteLength > 1000 * 1000 * 10) {
                    console.log(`Received large packet ${formatNumber(message.byteLength)}B at ${Date.now()}`);
                }
                if (!pendingCall) {
                    throw new Error(`Received data without size`);
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