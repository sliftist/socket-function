import { CallerContext, CallerContextBase, CallType, FullCallType } from "../SocketFunctionTypes";
import * as ws from "ws";
import { performLocalCall } from "./callManager";
import { convertErrorStackToError, formatNumberSuffixed, isNode, list } from "./misc";
import { createWebsocketFactory, getTLSSocket } from "./websocketFactory";
import { SocketFunction } from "../SocketFunction";
import { gzip } from "zlib";
import * as tls from "tls";
import { getClientNodeId, getNodeIdLocation, registerNodeClient } from "./nodeCache";
import debugbreak from "debugbreak";
import { lazy } from "./caching";
import { JSONLACKS } from "./JSONLACKS/JSONLACKS";
import { red, yellow } from "./formatting/logColors";
import { isSplitableArray, markArrayAsSplitable } from "./fixLargeNetworkCalls";
import { delay } from "./batching";

const MIN_RETRY_DELAY = 1000;

type InternalCallType = FullCallType & {
    seqNum: number;
    isReturn: false;
    compress: boolean;
}

type InternalReturnType = {
    isReturn: true;
    result: unknown;
    error?: string;
    seqNum: number;
    resultSize: number;
    compressed: boolean;
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
        data: Buffer;
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
                compress: !!SocketFunction.compression,
            };
            let time = Date.now();
            let data = Buffer.from(JSONLACKS.stringify(fullCall));
            time = Date.now() - time;
            if (time > SocketFunction.WIRE_WARN_TIME) {
                console.log(red(`Slow serialize, took ${time}ms to serialize ${data.byteLength} bytes. For ${call.classGuid}.${call.functionName}`));
            }

            if (data.byteLength > SocketFunction.MAX_MESSAGE_SIZE * 1.5) {
                let splitArgIndex = call.args.findIndex(isSplitableArray);
                if (splitArgIndex >= 0) {
                    console.log(yellow(`Splitting large call due to large args: ${call.classGuid}.${call.functionName}`));
                    let SPLIT_GROUPS = 10;
                    let splitArg = call.args[splitArgIndex] as unknown[];
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

                throw new Error(`Call too large to send (${call.classGuid}.${call.functionName}, size: ${data.byteLength} > ${SocketFunction.MAX_MESSAGE_SIZE}). If you need to handle very large static data use some external service, such as Backblaze B2 or AWS S3. Or consider fragmenting data at an application level, because sending large data will cause large lag spikes for other clients using this server. Or, if absolutely required, set SocketFunction.MAX_MESSAGE_SIZE to a higher value.`);
            }

            let resultPromise = new Promise((resolve, reject) => {
                let callback = (result: InternalReturnType) => {
                    if (SocketFunction.logMessages) {
                        console.log(`SIZE\t${(formatNumberSuffixed(result.resultSize) + "B").padEnd(4, " ")}\t${call.classGuid}.${call.functionName}`);
                    }
                    pendingCalls.delete(seqNum);
                    if (result.error) {
                        reject(convertErrorStackToError(result.error));
                    } else {
                        resolve(result.result);
                    }
                };
                pendingCalls.set(seqNum, { callback, data, call: fullCall });
            });

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
                    resultSize: 0,
                    compressed: false,
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

    async function send(data: Buffer) {
        if (!webSocketPromise) {
            if (canReconnect) {
                webSocketPromise = tryToReconnect();
            } else {
                throw new Error(`Cannot send data to ${niceConnectionName} as the connection has closed`);
            }
        }
        let webSocket = await webSocketPromise;
        webSocket.send(data);
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


    async function onMessage(message: ws.RawData | ws.MessageEvent | string) {
        try {
            if (typeof message === "object" && "data" in message) {
                message = message.data;
            }
            if (!isNode()) {
                if (message instanceof Blob) {
                    message = Buffer.from(await message.arrayBuffer());
                }
            }
            if (message instanceof Buffer || typeof message === "string") {

                let resultSize = message.length;

                if (message instanceof Buffer && message[0] === 0) {
                    // First byte of 0 means it is decompressed (as JSON can't have a first byte of 0).
                    (message as any) = message.slice(1);

                    // TODO: Add typings for DecompressionStream
                    let DecompressionStream = (window as any).DecompressionStream;
                    // https://stackoverflow.com/a/68829631/1117119
                    let stream = new DecompressionStream("gzip");
                    let blob = new Blob([message]);
                    let decompressedStream = (await (blob.stream() as any).pipeThrough(stream));
                    let arrayBuffer = await new Response(decompressedStream).arrayBuffer();
                    (message as any) = Buffer.from(arrayBuffer);
                }

                let time = Date.now();
                let call = JSONLACKS.parse(message.toString(), { extended: false }) as InternalCallType | InternalReturnType;
                time = Date.now() - time;

                if (call.isReturn) {
                    let callbackObj = pendingCalls.get(call.seqNum);
                    if (time > SocketFunction.WIRE_WARN_TIME) {
                        console.log(red(`Slow parse, took ${time}ms to parse ${message.length} bytes, for receieving result of call to ${callbackObj?.call.classGuid}.${callbackObj?.call.functionName}`));
                    }
                    if (!callbackObj) {
                        console.log(`Got return for unknown call ${call.seqNum}`);
                        return;
                    }
                    call.resultSize = resultSize;
                    callbackObj.callback(call);
                } else {
                    if (time > SocketFunction.WIRE_WARN_TIME) {
                        console.log(red(`Slow parse, took ${time}ms to parse ${message.length} bytes, for call to ${call.classGuid}.${call.functionName}`));
                    }

                    let response: InternalReturnType;
                    try {
                        let result = await performLocalCall({ call, caller: callerContext });
                        response = {
                            isReturn: true,
                            result,
                            seqNum: call.seqNum,
                            resultSize: resultSize,
                            compressed: false,
                        };
                    } catch (e: any) {
                        response = {
                            isReturn: true,
                            result: undefined,
                            seqNum: call.seqNum,
                            error: e.stack,
                            resultSize: resultSize,
                            compressed: false,
                        };
                    }

                    let result: Buffer;
                    if (isNode() && call.compress && SocketFunction.compression?.type === "gzip") {
                        response.compressed = true;
                        result = Buffer.from(JSONLACKS.stringify(response));
                        result = await new Promise<Buffer>((resolve, reject) =>
                            gzip(result, (err, result) => err ? reject(err) : resolve(result))
                        );
                        result = Buffer.concat([new Uint8Array([0]), result]);
                    } else {
                        result = Buffer.from(JSONLACKS.stringify(response));
                    }
                    if (result.byteLength > SocketFunction.MAX_MESSAGE_SIZE * 1.5) {
                        response = {
                            isReturn: true,
                            result: undefined,
                            seqNum: call.seqNum,
                            error: new Error(`Response too large to send (${call.classGuid}.${call.functionName}, size: ${result.byteLength} > ${SocketFunction.MAX_MESSAGE_SIZE}). If you need to handle very large static data use some external service, such as Backblaze B2 or AWS S3. Or consider fragmenting data at an application level, because sending large data will cause large lag spikes for other clients using this server. Or, if absolutely required, set SocketFunction.MAX_MESSAGE_SIZE to a higher value.`).stack,
                            resultSize: resultSize,
                            compressed: false,
                        };
                        result = Buffer.from(JSONLACKS.stringify(response));
                    }
                    await send(result);
                }
                return;
            }
            throw new Error(`Unhandled data type ${typeof message}`);
        } catch (e: any) {
            debugbreak(2);
            debugger;
            console.error(e.stack);
        }
    }

    return callFactory;
}