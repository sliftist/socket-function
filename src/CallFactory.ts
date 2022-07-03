import { CallerContext, CallType, NetworkLocation } from "../SocketFunctionTypes";
import type * as ws from "ws";
import type * as net from "net";
import { performLocalCall } from "./callManager";
import { convertErrorStackToError, isNode } from "./misc";
import { createWebsocket, getNodeId, getTLSSocket } from "./nodeAuthentication";
import debugbreak from "debugbreak";
import http from "http";

const retryInterval = 2000;

type InternalCallType = CallType & {
    seqNum: number;
    isReturn: false;
}

type InternalReturnType = {
    isReturn: true;
    result: unknown;
    error?: string;
    seqNum: number;
};


export interface CallFactory {
    nodeId: string;
    location: NetworkLocation;
    // NOTE: May or may not have reconnection or retry logic inside of performCall.
    //  Trigger performLocalCall on the other side of the connection
    performCall(call: CallType): Promise<unknown>;
}


export async function callFactoryFromLocation(
    location: NetworkLocation
): Promise<CallFactory> {
    if (location.localPort !== 0) {
        throw new Error(`Expected localPort to be 0, but it was ${location.localPort}`);
    }

    let listeningPort = location.listeningPorts[0];
    if (typeof listeningPort !== "number") {
        throw new Error(`Expected listeningPorts to be provided, but it was empty`);
    }

    return await createCallFactory(undefined, location);
}

export async function callFactoryFromWS(
    webSocket: ws.WebSocket & { nodeId?: string },
): Promise<CallFactory> {
    let socket = getTLSSocket(webSocket);
    let remoteAddress = socket.remoteAddress;
    let remotePort = socket.remotePort;
    if (!remoteAddress) {
        throw new Error("No remote address?");
    }
    if (!remotePort) {
        throw new Error("No remote port?");
    }

    // NOTE: We COULD reconnect to clients, but... chances are... when they go down,
    //  their process is dead, and is going to stay dead.
    let location: NetworkLocation = {
        address: remoteAddress,
        localPort: remotePort,
        listeningPorts: [],
    };

    return await createCallFactory(webSocket, location);
}

export interface SenderInterface {
    nodeId?: string;

    send(data: string): void;

    on(event: "open", listener: () => void): this;
    on(event: "close", listener: (code: number, reason: Buffer) => void): this;
    on(event: "error", listener: (err: Error) => void): this;
    on(event: "message", listener: (data: ws.RawData, isBinary: boolean) => void): this;
}

async function createCallFactory(
    webSocketBase: SenderInterface | undefined,
    location: NetworkLocation,
): Promise<CallFactory> {

    let closedForever = false;

    let niceConnectionName = `${location.address}:${location.localPort}`;

    let retriesEnabled = location.listeningPorts.length === 0;

    let lastReceivedSeqNum = 0;

    let reconnectingPromise: Promise<void> | undefined;
    let reconnectAttempts = 0;


    let pendingCalls: Map<number, {
        data: string;
        call: InternalCallType;
        reconnectTimeout: number | undefined;
        callback: (result: InternalReturnType) => void;
    }> = new Map();
    // NOTE: It is important to make this as random as possible, to prevent
    //  reconnections dues to a process being reset causing seqNum collisions
    //  in return calls.
    let nextSeqNum = Math.random();

    const pendingNodeId = "PENDING";
    let callerContext: CallerContext = { location, nodeId: pendingNodeId };
    let webSocket!: SenderInterface;
    if (!webSocketBase) {
        await tryToReconnect();
    } else {
        webSocket = webSocketBase;
        setupWebsocket(webSocketBase);
    }
    if (isNode()) {
        callerContext.nodeId = getNodeId(webSocket);
    } else {
        callerContext.nodeId = location.address + ":" + location.listeningPorts[0];
    }

    niceConnectionName = `${niceConnectionName} (${callerContext.nodeId})`;

    async function sendWithRetry(reconnectTimeout: number | undefined, data: string) {
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
                let ports = location.listeningPorts;

                if (ports.length === 0) {
                    closedForever = true;
                    console.log(`No ports to reconnect for ${niceConnectionName}, pendingCall count: ${pendingCalls.size}`);
                    for (let call of pendingCalls.values()) {
                        call.callback({
                            isReturn: true,
                            result: undefined,
                            error: `Connection lost to ${location.address}:${location.localPort}`,
                            seqNum: call.call.seqNum,
                        });
                    }
                    return;
                }

                let port = ports[reconnectAttempts % ports.length];
                let newWebSocket = createWebsocket(location.address, port);

                setupWebsocket(newWebSocket);

                let connectError = await new Promise<string | undefined>(resolve => {
                    newWebSocket.on("open", () => {
                        resolve(undefined);
                    });
                    newWebSocket.on("close", () => {
                        resolve("Connection closed for non-error reason?");
                    });
                    newWebSocket.on("error", e => {
                        resolve(String(e.stack));
                    });
                });

                if (!connectError) {
                    console.log(`Reconnected to ${location.address}:${port}`);

                    // NOTE: Clientside doesn't have access to peer certificates, so it can't know the nodeId of the server
                    //  that way. However, it can 
                    if (isNode()) {
                        let newNodeId = getNodeId(newWebSocket);
                        let prevNodeId = callerContext.nodeId;
                        if (prevNodeId === pendingNodeId) {
                            callerContext.nodeId = newNodeId;
                        } else {
                            if (newNodeId !== prevNodeId) {
                                throw new Error(`Connection lost to at ${niceConnectionName} ("${prevNodeId}"), but then re-established, however it is now "${newNodeId}"!`);
                            }
                        }
                    }

                    // I'm not sure if we should clear reconnectAttempts? All the ports should be the same, and actually...
                    //  why would there even be a bad port?
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
                            });
                        });
                    }
                    return;
                }

                console.error(`Connection retry to ${location.address}:${port} failed, retrying in ${retryInterval}ms`);
                reconnectAttempts++;
                await new Promise(resolve => setTimeout(resolve, retryInterval));
            }
        })();
    }

    function setupWebsocket(webSocket: SenderInterface) {
        webSocket.on("error", e => {
            console.log(`Websocket error for ${niceConnectionName}`, e);
        });

        webSocket.on("close", async () => {
            console.log(`Websocket closed ${niceConnectionName}`);
            if (retriesEnabled) {
                await tryToReconnect();
            }
        });

        webSocket.on("message", onMessage);
    }


    async function onMessage(message: ws.RawData | MessageEvent | string) {
        try {
            if (!isNode()) {
                if (typeof message === "object" && "data" in message) {
                    message = message.data;
                }
            }
            if (message instanceof Buffer || typeof message === "string") {
                let call = JSON.parse(message.toString()) as InternalCallType | InternalReturnType;
                if (call.isReturn) {
                    let callbackObj = pendingCalls.get(call.seqNum);
                    if (!callbackObj) {
                        console.log(`Got return for unknown call ${call.seqNum}`);
                        return;
                    }
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
                        };
                    } catch (e: any) {
                        response = {
                            isReturn: true,
                            result: undefined,
                            seqNum: call.seqNum,
                            error: e.stack,
                        };
                    }

                    await sendWithRetry(call.reconnectTimeout, JSON.stringify(response));
                }
                return;
            }
            debugbreak(1);
            debugger;
            throw new Error(`Unhandled data type ${typeof message}`);
        } catch (e: any) {
            console.error(e.stack);
        }
    }

    return {
        nodeId: callerContext.nodeId,
        location,
        async performCall(call: CallType) {
            if (closedForever) {
                throw new Error(`Connection lost to ${location.address}:${location.localPort}`);
            }

            let seqNum = nextSeqNum++;
            let fullCall: InternalCallType = {
                isReturn: false,
                args: call.args,
                classGuid: call.classGuid,
                functionName: call.functionName,
                seqNum,
            };
            let data = JSON.stringify(fullCall);
            let resultPromise = new Promise((resolve, reject) => {
                let callback = (result: InternalReturnType) => {
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
}