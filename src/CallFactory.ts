import { CallerContext, CallerContextBase, CallType, FullCallType } from "../SocketFunctionTypes";
import * as ws from "ws";
import { performLocalCall, shouldCompressCall } from "./callManager";
import { convertErrorStackToError, formatNumberSuffixed, isNode, list } from "./misc";
import { createWebsocketFactory, getTLSSocket } from "./websocketFactory";
import { SocketFunction } from "../SocketFunction";
import * as tls from "tls";
import { getClientNodeId, getNodeIdLocation, registerNodeClient } from "./nodeCache";
import debugbreak from "debugbreak";
import { lazy } from "./caching";
import { red, yellow } from "./formatting/logColors";
import { isSplitableArray, markArrayAsSplitable } from "./fixLargeNetworkCalls";
import { delay, runInSerial } from "./batching";
import { formatNumber, formatTime } from "./formatting/format";
import pako from "pako";
import { setFlag } from "../require/compileFlags";
setFlag(require, "pako", "allowclient", true);

const MIN_RETRY_DELAY = 1000;

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
    socket?: tls.TLSSocket;

    send(data: string | Buffer): void;

    addEventListener(event: "open", listener: () => void): void;
    addEventListener(event: "close", listener: () => void): void;
    addEventListener(event: "error", listener: (err: { message: string }) => void): void;
    addEventListener(event: "message", listener: (data: ws.RawData | ws.MessageEvent | string) => void): void;

    readyState: number;

    ping?(): void;
}

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
            let originalArgs = call.args;
            if (shouldCompressCall(fullCall)) {
                fullCall.args = await compressObj(fullCall.args) as any;
                fullCall.isArgsCompressed = true;
            }
            let time = Date.now();
            let data: Buffer[];
            let dataMaybePromise = SocketFunction.WIRE_SERIALIZER.serialize(fullCall);
            if (dataMaybePromise instanceof Promise) {
                data = await dataMaybePromise;
            } else {
                data = dataMaybePromise;
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
                let callback = (result: InternalReturnType) => {
                    pendingCalls.delete(seqNum);
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
                    console.log(`SIZE\t${(formatNumberSuffixed(resultSize) + "B").padEnd(4, " ")}\t${call.classGuid}.${call.functionName}${fncHack} at ${Date.now()}`);
                }
            }
            await send(data);

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
            webSocketPromise = undefined;
            if (!canReconnect) {
                callFactory.closedForever = true;
            }
            for (let [key, call] of pendingCalls) {
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
            onClose(`Connection error for ${niceConnectionName}: ${e.message}`);
        });

        newWebSocket.addEventListener("close", async () => {
            //console.log(`Websocket closed ${niceConnectionName}`);
            onClose(`Connection closed to ${niceConnectionName}`);
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
        } else if (newWebSocket.readyState !== 1 /* OPEN */) {
            onClose(`Websocket received in closed state`);
            callFactory.isConnected = true;
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
    async function sendRaw(data: (string | Buffer)[]) {
        if (!webSocketPromise) {
            if (canReconnect) {
                webSocketPromise = tryToReconnect();
            } else {
                throw new Error(`Cannot send data to ${niceConnectionName} as the connection has closed`);
            }
        }
        let webSocket = await webSocketPromise;
        for (let d of data) {
            webSocket.send(d);
        }
    }
    async function send(data: Buffer[]) {
        sendRaw([
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
            } else {
                throw new Error(`Cannot send large amounts of data unless we are returning Buffer or Buffer[]`);
            }
        }
        // if (totalResultSize > SocketFunction.MAX_MESSAGE_SIZE * 1.5) {
        // Split up Buffer[] if they are too large
        sendRaw([
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
    let clientsideSerial = runInSerial(async <T>(val: Promise<T>) => val);
    async function onMessage(message: ws.RawData | ws.MessageEvent | string) {
        try {
            if (typeof message === "object" && "data" in message) {
                message = message.data;
            }
            if (!isNode()) {
                if (message instanceof Blob) {
                    // We need to force the results to be in serial, otherwise strings leapfrog
                    //  ahead of buffers, which breaks things.
                    message = Buffer.from(await clientsideSerial(message.arrayBuffer()));
                } else {
                    await clientsideSerial(Promise.resolve());
                }
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
                return;
            }
            if (message instanceof Buffer) {
                if (!pendingCall) {
                    throw new Error(`Received data without size`);
                }
                pendingCall.buffers.push(message);
                let currentBuffers: Buffer[];
                if (pendingCall.buffers.length !== pendingCall.bufferCount) {
                    return;
                }

                let currentCall = pendingCall;
                pendingCall = undefined;
                currentBuffers = currentCall.buffers;
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
                                let buf = currentBuffers.pop();
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
                        console.log(red(`Slow parse, took ${time}ms to parse ${resultSize} bytes, for receieving result of call to ${callbackObj?.call.classGuid}.${callbackObj?.call.functionName}`));
                    }
                    if (!callbackObj) {
                        console.log(`Got return for unknown call ${call.seqNum} (created at time ${new Date(call.seqNum)})`);
                        return;
                    }
                    if (SocketFunction.logMessages) {
                        let call = callbackObj.call;
                        console.log(`SIZE\t${(formatNumberSuffixed(resultSize) + "B").padEnd(4, " ")}\t${call.classGuid}.${call.functionName} at ${Date.now()}`);
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
                        console.log(`SIZE\t${(formatNumberSuffixed(resultSize) + "B").padEnd(4, " ")}\t${call.classGuid}.${call.functionName} at ${Date.now()}`);
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
                        let result: Buffer[] = await SocketFunction.WIRE_SERIALIZER.serialize(response);
                        let totalResultSize = result.map(x => x.length).reduce((a, b) => a + b, 0);
                        if (totalResultSize > SocketFunction.MAX_MESSAGE_SIZE * 1.5) {
                            response = {
                                isReturn: true,
                                result: undefined,
                                seqNum: call.seqNum,
                                error: new Error(`Response too large to send (${call.classGuid}.${call.functionName}, size: ${formatNumber(totalResultSize)} > ${formatNumber(SocketFunction.MAX_MESSAGE_SIZE)}). If you need to handle very large static data use some external service, such as Backblaze B2 or AWS S3. Or consider fragmenting data at an application level, because sending large data will cause large lag spikes for other clients using this server. Or, if absolutely required, set SocketFunction.MAX_MESSAGE_SIZE to a higher value.`).stack,
                            };
                            result = await SocketFunction.WIRE_SERIALIZER.serialize(response);
                        }
                        await send(result);
                    }
                }
                return;
            }
            throw new Error(`Unhandled data type ${typeof message}`);
        } catch (e: any) {
            let message = e.stack || e.message || e;
            // NOTE: I'm looking for all types of errors here (specifically, .send errors), in case
            //  there are errors I should be handling.
            if (message.startsWith("Error: Cannot send data to") && message.includes("as the connection has closed")) {
                // This is fine, just ignore it
            } else {
                debugbreak(2);
                debugger;
                console.error(e.stack);
            }
        }
    }

    return callFactory;
}


async function compressObj(obj: unknown): Promise<Buffer> {
    let buffers = await SocketFunction.WIRE_SERIALIZER.serialize(obj);
    let lengthBuffer = Buffer.from((new Float64Array(buffers.map(x => x.length))).buffer);
    let buffer = Buffer.concat([lengthBuffer, ...buffers]);
    return Buffer.from(pako.gzip(buffer));
}
async function decompressObj(obj: Buffer): Promise<unknown> {
    try {
        let buffer = Buffer.from(pako.ungzip(obj));
        let lengthBuffer = buffer.slice(0, 8);
        let lengths = new Float64Array(lengthBuffer.buffer, lengthBuffer.byteOffset, lengthBuffer.byteLength / 8);
        let buffers: Buffer[] = [];
        let offset = 8;
        for (let length of lengths) {
            buffers.push(buffer.slice(offset, offset + length));
            offset += length;
        }

        return await SocketFunction.WIRE_SERIALIZER.deserialize(buffers);
    } catch (e) {
        // We were encountering issues with the checksum failing when unzipping. Presumably if the data
        //      is bad deserialize will also fail. I can't repro it anymore though...
        debugbreak(2);
        debugger;
        throw e;
    }
}