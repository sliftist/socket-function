import { CallerContext, CallerContextBase, CallType } from "../SocketFunctionTypes";
import * as ws from "ws";
import { performLocalCall } from "./callManager";
import { convertErrorStackToError, formatNumberSuffixed, isNode } from "./misc";
import { createWebsocketFactory, getNodeIdFromCert, getTLSSocket } from "./nodeAuthentication";
import { SocketFunction } from "../SocketFunction";
import { gzip } from "zlib";
import * as tls from "tls";
import { getClientNodeId, getNodeIdLocation, registerNodeClient } from "./nodeCache";

const retryInterval = 2000;

type InternalCallType = CallType & {
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
    // NOTE: May or may not have reconnection or retry logic inside of performCall.
    //  Trigger performLocalCall on the other side of the connection
    performCall(call: CallType): Promise<unknown>;
    closedForever: boolean;
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
}

export async function createCallFactory(
    webSocketBase: SenderInterface | undefined,
    nodeId: string,
    localNodeId: string,
): Promise<CallFactory> {
    let niceConnectionName = nodeId;

    const createWebsocket = createWebsocketFactory();

    let retriesEnabled = !!getNodeIdLocation(nodeId);

    let lastReceivedSeqNum = 0;

    let reconnectingPromise: Promise<void> | undefined;
    let reconnectAttempts = 0;


    let pendingCalls: Map<number, {
        data: Buffer;
        call: InternalCallType;
        reconnectTimeout: number | undefined;
        callback: (resultJSON: InternalReturnType) => void;
    }> = new Map();
    // NOTE: It is important to make this as random as possible, to prevent
    //  reconnections dues to a process being reset causing seqNum collisions
    //  in return calls.
    let nextSeqNum = Math.random();

    let callerContext: CallerContextBase = {
        nodeId,
        localNodeId,
        certInfo: webSocketBase?.socket?.getPeerCertificate(true),
        updateCertInfo: (certRaw, port) => {
            let nodeId = getNodeIdFromCert(certRaw, port);
            if (!nodeId) {
                return;
            }
            callerContext.nodeId = nodeId;
            callerContext.certInfo = certRaw;
        }
    };

    let callFactory: CallFactory = {
        nodeId,
        closedForever: false,
        async performCall(call: CallType) {
            if (callFactory.closedForever) {
                throw new Error(`Connection lost to ${niceConnectionName}`);
            }

            let seqNum = nextSeqNum++;
            let fullCall: InternalCallType = {
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
                pendingCalls.set(seqNum, { callback, data, call: fullCall, reconnectTimeout: call.reconnectTimeout });
            });

            await sendWithRetry(call.reconnectTimeout, data);

            return await resultPromise;
        }
    };

    let webSocket!: SenderInterface;
    if (!webSocketBase) {
        await tryToReconnect();
    } else {
        webSocket = webSocketBase;
        setupWebsocket(webSocketBase);
    }

    niceConnectionName = `${niceConnectionName} (${callerContext.nodeId})`;

    async function sendWithRetry(reconnectTimeout: number | undefined, data: Buffer) {
        if (!retriesEnabled) {
            webSocket.send(data);
            return;
        }

        while (true) {
            if (reconnectingPromise) {
                if (reconnectTimeout) {
                    await Promise.race([
                        reconnectingPromise,
                        new Promise<SenderInterface>(resolve =>
                            setTimeout(() => {
                                retriesEnabled = false;
                                resolve(webSocket);
                            }, reconnectTimeout)
                        )
                    ]);
                } else {
                    await reconnectingPromise;
                }
            }

            if (!retriesEnabled) {
                webSocket.send(data);
                break;
            }

            try {
                webSocket.send(data);
                break;
            } catch (e) {
                // Ignore errors, as we will catch them synchronously in the next loop.
                void (tryToReconnect());
            }
        }
    }
    function tryToReconnect(): Promise<void> {
        if (reconnectingPromise) return reconnectingPromise;
        return reconnectingPromise = (async () => {
            while (true) {
                if (!retriesEnabled) {
                    callFactory.closedForever = true;
                    console.log(`Cannot reconnect to ${niceConnectionName}, aborting pendingCalls: ${pendingCalls.size}`);
                    for (let call of pendingCalls.values()) {
                        call.callback({
                            isReturn: true,
                            result: undefined,
                            error: `Connection lost to ${niceConnectionName}`,
                            seqNum: call.call.seqNum,
                            resultSize: 0,
                            compressed: false,
                        });
                    }
                    return;
                }

                let newWebSocket = createWebsocket(nodeId);

                let connectError = await new Promise<string | undefined>(resolve => {
                    newWebSocket.addEventListener("open", () => {
                        resolve(undefined);
                    });
                    newWebSocket.addEventListener("close", () => {
                        resolve("Connection closed for non-error reason?");
                    });
                    newWebSocket.addEventListener("error", e => {
                        resolve(String(e.message));
                    });
                });

                setupWebsocket(newWebSocket);

                if (!connectError) {
                    console.log(`Reconnected to ${niceConnectionName}`);

                    // I'm not sure if we should clear reconnectAttempts? Maybe if we eventually have a max reconnectAttempts?
                    //reconnectAttempts = 0;
                    reconnectingPromise = undefined;

                    webSocket = newWebSocket;

                    for (let call of pendingCalls.values()) {
                        sendWithRetry(call.reconnectTimeout, call.data).catch(e => {
                            call.callback({
                                isReturn: true,
                                result: undefined,
                                error: String(e),
                                seqNum: call.call.seqNum,
                                resultSize: 0,
                                compressed: false,
                            });
                        });
                    }
                    return;
                }

                reconnectAttempts++;
                console.error(`Connection retry to ${niceConnectionName} failed (attempt ${reconnectAttempts}), retrying in ${retryInterval}ms, error: ${JSON.stringify(connectError)}`);
                await new Promise(resolve => setTimeout(resolve, retryInterval));
            }
        })();
    }

    function setupWebsocket(webSocket: SenderInterface) {
        registerNodeClient(callFactory);

        webSocket.addEventListener("error", e => {
            console.log(`Websocket error for ${niceConnectionName}`, e);
        });

        webSocket.addEventListener("close", async () => {
            console.log(`Websocket closed ${niceConnectionName}`);
            if (retriesEnabled) {
                await tryToReconnect();
            }
        });

        webSocket.addEventListener("message", onMessage);
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
                    await sendWithRetry(call.reconnectTimeout, result);
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