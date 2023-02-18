import { CallerContext, CallerContextBase, CallType, FullCallType } from "../SocketFunctionTypes";
import * as ws from "ws";
import { performLocalCall } from "./callManager";
import { convertErrorStackToError, formatNumberSuffixed, isNode } from "./misc";
import { createWebsocketFactory, getTLSSocket } from "./websocketFactory";
import { SocketFunction } from "../SocketFunction";
import { gzip } from "zlib";
import * as tls from "tls";
import { getClientNodeId, getNodeIdLocation, registerNodeClient } from "./nodeCache";
import debugbreak from "debugbreak";
import { lazy } from "./caching";

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
}

export async function createCallFactory(
    webSocketBase: SenderInterface | undefined,
    nodeId: string,
    localNodeId: string,
): Promise<CallFactory> {
    let niceConnectionName = nodeId;

    const createWebsocket = createWebsocketFactory();
    const registerOnce = lazy(() => registerNodeClient(callFactory));

    const canReconnect = !!getNodeIdLocation(nodeId);

    let lastReceivedSeqNum = 0;

    let pendingCalls: Map<number, {
        data: Buffer;
        call: InternalCallType;
        callback: (resultJSON: InternalReturnType) => void;
    }> = new Map();
    // NOTE: It is important to make this as random as possible, to prevent
    //  reconnections dues to a process being reset causing seqNum collisions
    //  in return calls.
    let nextSeqNum = Math.random();

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
            let data = Buffer.from(JSON.stringify(fullCall));
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
                    console.log(`Connection established to ${niceConnectionName}`);
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

                let call = JSON.parse(message.toString()) as InternalCallType | InternalReturnType;
                if (call.isReturn) {
                    let callbackObj = pendingCalls.get(call.seqNum);
                    if (!callbackObj) {
                        console.log(`Got return for unknown call ${call.seqNum}`);
                        return;
                    }
                    call.resultSize = resultSize;
                    callbackObj.callback(call);
                } else {
                    if (call.seqNum <= lastReceivedSeqNum) {
                        console.log(`Received out of sequence call ${call.seqNum}`);
                        return;
                    }
                    lastReceivedSeqNum = call.seqNum;

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
                        result = Buffer.from(JSON.stringify(response));
                        result = await new Promise<Buffer>((resolve, reject) =>
                            gzip(result, (err, result) => err ? reject(err) : resolve(result))
                        );
                        result = Buffer.concat([new Uint8Array([0]), result]);
                    } else {
                        result = Buffer.from(JSON.stringify(response));
                    }
                    await send(result);
                }
                return;
            }
            throw new Error(`Unhandled data type ${typeof message}`);
        } catch (e: any) {
            console.error(e.stack);
        }
    }

    return callFactory;
}