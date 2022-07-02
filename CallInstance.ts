import { CallerContext, CallType, NetworkLocation } from "./SocketFunctionTypes";
import type * as ws from "ws";
import type * as net from "net";
import { performLocalCall } from "./callManager";
import { convertErrorStackToError } from "./misc";
import { createWebsocket, getNodeId, getTLSSocket } from "./nodeAuthentication";

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
    webSocket: ws.WebSocket
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

async function createCallFactory(
    webSocketBase: ws.WebSocket | undefined,
    location: NetworkLocation,
): Promise<CallFactory> {

    let niceConnectionName = `${location.address}:${location.localPort}`;

    let retriesEnabled = location.listeningPorts.length === 0;


    let reconnectingPromise: Promise<ws.WebSocket>|undefined;
    let reconnectAttempts = 0;
    
    
    let pendingCalls: Map<number, (result: InternalReturnType) => void> = new Map();
    // NOTE: It is important to make this as random as possible, to prevent
    //  reconnections dues to a process being reset causing seqNum collisions
    //  in return calls.
    let nextSeqNum = Math.random();


    if (!webSocketBase) {
        webSocketBase = await tryToReconnect();
    }
    let webSocket = webSocketBase;

    if (webSocket) {
        setupWebsocket(webSocket);
    }

    let callerContext: CallerContext = { location, nodeId: getNodeId(webSocket) };
    
    async function sendWithRetry(reconnectTimeout: number|undefined, data: string) {

        if (!retriesEnabled) {
            webSocket.send(data);
            return;
        }
        while (true) {
            if (reconnectingPromise) {
                if(reconnectTimeout) {
                    await Promise.race([
                        reconnectingPromise,
                        new Promise<void>(resolve =>
                            setTimeout(() => {
                                retriesEnabled = false;
                                resolve();
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
            } catch(e) {
                // Ignore errors, as we will catch them synchronously in the next loop.
                void (tryToReconnect());
            }
        }
    }
    function tryToReconnect(): Promise<ws.WebSocket> {
        if (reconnectingPromise) return reconnectingPromise;
        return reconnectingPromise = (async () => {
            while(true) {
                let ports = location.listeningPorts;
                let port = ports[reconnectAttempts % ports.length];
                let newWebSocket = createWebsocket(location.address, port);

                setupWebsocket(newWebSocket);

                let connectError = await new Promise<string|undefined>(resolve => {
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

                webSocket = newWebSocket;

                let newNodeId = getNodeId(webSocket);

                let prevNodeId = callerContext.nodeId;
                if (newNodeId !== prevNodeId) {
                    throw new Error(`Connection lost to at ${niceConnectionName} ("${prevNodeId}"), but then re-established, however it is now "${newNodeId}"!`);
                }

                if(!connectError) {
                    break;
                }

                const retryInterval = 5000;
                console.error(`Connection retry to ${location.address}:${port} failed, retrying in ${retryInterval}ms`);
                reconnectAttempts++;
                await new Promise(resolve => setTimeout(resolve, retryInterval));
            }

            // I'm not sure if we should clear reconnectAttempts? All the ports should be the same, and actually...
            //  why would there even be a bad port?
            //reconnectAttempts = 0;
            reconnectingPromise = undefined;

            return webSocket;
        })();
    }

    function setupWebsocket(webSocket: ws.WebSocket) {
        webSocket.on("error", e => {
            console.log(`Websocket error for ${niceConnectionName}`, e);
        });
    
        webSocket.on("close", tryToReconnect);
    
        webSocket.on("message", onMessage);
    }


    async function onMessage(message: ws.RawData) {
        try {
            if (typeof message === "string") {
                let call = JSON.parse(message) as InternalCallType | InternalReturnType;
                if (call.isReturn) {
                    let callback = pendingCalls.get(call.seqNum);
                    if(!callback) {
                        console.log(`Got return for unknown call ${call.seqNum}`);
                        return;
                    }
                    pendingCalls.delete(call.seqNum);
                    callback(call);
                } else {
                    let response: InternalReturnType;
                    try {
                        let result = await performLocalCall({ call, caller: callerContext });
                        response = {
                            isReturn: true,
                            result,
                            seqNum: call.seqNum,
                        };
                    } catch(e: any) {
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
            throw new Error(`Unhandled data type ${typeof message}`);
        } catch(e: any) {
            console.error(e.stack);
        }
    }

    return {
        nodeId: callerContext.nodeId,
        location,
        async performCall(call: CallType) {
            let seqNum = nextSeqNum++;
            let fullCall: InternalCallType = {
                isReturn: false,
                args: call.args,
                classGuid: call.classGuid,
                functionName: call.functionName,
                seqNum,
            };
            let resultPromise = new Promise((resolve, reject) => {
                let callback = (result: InternalReturnType) => {
                    if (result.error) {
                        reject(convertErrorStackToError(result.error));
                    } else {
                        resolve(result.result);
                    }
                };
                pendingCalls.set(seqNum, callback);
            });

            await sendWithRetry(call.reconnectTimeout, JSON.stringify(fullCall));

            return await resultPromise;
        }
    };
}