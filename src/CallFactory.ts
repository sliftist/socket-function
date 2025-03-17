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
import { measureFnc, measureWrap } from "./profiling/measure";
import { MaybePromise } from "./types";
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
            try {
                if (shouldCompressCall(fullCall)) {
                    fullCall.args = await compressObj(fullCall.args) as any;
                    fullCall.isArgsCompressed = true;
                }
                let dataMaybePromise = SocketFunction.WIRE_SERIALIZER.serialize(fullCall);
                if (dataMaybePromise instanceof Promise) {
                    data = await dataMaybePromise;
                } else {
                    data = dataMaybePromise;
                }
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
        time = Date.now() - time;
        for (let callback of SocketFunction.trackMessageSizes.download) {
            callback(resultSize);
        }

        if (call.isReturn) {
            let callbackObj = pendingCalls.get(call.seqNum);
            if (time > SocketFunction.WIRE_WARN_TIME) {
                console.log(red(`Slow parse, took ${time}ms to parse ${resultSize} bytes, for receiving result of call to ${callbackObj?.call.classGuid}.${callbackObj?.call.functionName}`));
            }
            if (!callbackObj) {
                console.log(`Got return for unknown call ${call.seqNum} (created at time ${new Date(call.seqNum)})`);
                return;
            }
            if (SocketFunction.logMessages) {
                let call = callbackObj.call;
                console.log(`SIZE\t${(formatNumberSuffixed(resultSize) + "B").padEnd(4, " ")}\tRETURN\t${call.classGuid}.${call.functionName} at ${Date.now()}`);
            }
            if (call.isResultCompressed) {
                call.result = await decompressObj(call.result as Buffer);
                call.isResultCompressed = false;
            }
            callbackObj.callback(call);
        } else {
            if (call.isArgsCompressed) {
                call.args = await decompressObj(call.args as any as Buffer) as any;
                call.isArgsCompressed = false;
            }
            if (SocketFunction.logMessages) {
                console.log(`SIZE\t${(formatNumberSuffixed(resultSize) + "B").padEnd(4, " ")}\tEVALUATE\t${call.classGuid}.${call.functionName} at ${Date.now()}`);
            }
            if (time > SocketFunction.WIRE_WARN_TIME) {
                console.log(red(`Slow parse, took ${time}ms to parse ${resultSize} bytes, for call to ${call.classGuid}.${call.functionName}`));
            }

            let response: InternalReturnType;
            try {
                let result = await performLocalCall({ call, caller: callerContext });
                response = {
                    isReturn: true,
                    result,
                    seqNum: call.seqNum,
                };
                if (shouldCompressCall(call)) {
                    response.result = await compressObj(response.result) as any;
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

            if (response.result instanceof Buffer) {
                let { result, ...remaining } = response;
                await sendWithHeader([result], { type: "Buffer", bufferCount: 1, metadata: remaining });
            } else if (Array.isArray(response.result) && response.result.every(x => x instanceof Buffer)) {
                let { result, ...remaining } = response;
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
                await send(result);
            }
        }
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

async function doStream(stream: GenericTransformStream, buffer: Buffer): Promise<Buffer> {
    let reader = stream.readable.getReader();
    let writer = stream.writable.getWriter();
    let writePromise = writer.write(buffer);
    let closePromise = writer.close();

    let outputBuffers: Buffer[] = [];
    while (true) {
        let { value, done } = await reader.read();
        if (done) {
            await writePromise;
            await closePromise;
            return Buffer.concat(outputBuffers);
        }
        outputBuffers.push(Buffer.from(value));
    }
}
async function unzipBase(buffer: Buffer): Promise<Buffer> {
    if (isNode()) {
        return new Promise((resolve, reject) => {
            zlib.gunzip(buffer, (err: any, result: Buffer) => {
                if (err) reject(err);
                else resolve(result);
            });
        });
    } else {
        // NOTE: pako seems to be faster, at least clientside.
        // TIMING: 700ms vs 1200ms
        //  - This might just be faster for small files.
        return Buffer.from(pako.inflate(buffer));
        // @ts-ignore
        // return await doStream(new DecompressionStream("gzip"), buffer);
    }
}
async function zipBase(buffer: Buffer, level?: number): Promise<Buffer> {
    if (isNode()) {
        return new Promise((resolve, reject) => {
            zlib.gzip(buffer, { level }, (err: any, result: Buffer) => {
                if (err) reject(err);
                else resolve(result);
            });
        });
    } else {
        // @ts-ignore
        return await doStream(new CompressionStream("gzip"), buffer);
    }
}

const compressObj = measureWrap(async function wireCallCompress(obj: unknown): Promise<Buffer> {
    let buffers = await SocketFunction.WIRE_SERIALIZER.serialize(obj);
    let lengthBuffer = Buffer.from((new Float64Array(buffers.map(x => x.length))).buffer);
    let buffer = Buffer.concat([lengthBuffer, ...buffers]);
    let result = await zipBase(buffer);
    return result;
});
const decompressObj = measureWrap(async function wireCallDecompress(obj: Buffer): Promise<unknown> {
    let buffer = await unzipBase(obj);
    let lengthBuffer = buffer.slice(0, 8);
    let lengths = new Float64Array(lengthBuffer.buffer, lengthBuffer.byteOffset, lengthBuffer.byteLength / 8);
    let buffers: Buffer[] = [];
    let offset = 8;
    for (let length of lengths) {
        buffers.push(buffer.slice(offset, offset + length));
        offset += length;
    }
    return await SocketFunction.WIRE_SERIALIZER.deserialize(buffers);
});