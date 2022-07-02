import { CallerContext, CallType, NetworkLocation } from "./SocketFunctionTypes";
import * as ws from "ws";
import * as net from "net";
import { performLocalCall } from "./callManager";
import { convertErrorStackToError } from "./misc";
import { getNodeId } from "./nodeAuthentication";

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

    let webSocket = new ws.WebSocket(`ws://${location.address}:${listeningPort}`);

    return createCallFactory(webSocket, location);
}

export function callFactoryFromWS(
    webSocket: ws.WebSocket,
    socket: net.Socket,
): CallFactory {
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

    return createCallFactory(webSocket, location);
}

function createCallFactory(
    webSocket: ws.WebSocket,
    location: NetworkLocation,
): CallFactory {

    let niceConnectionName = `${location.address}:${location.localPort}`;

    let nodeId: string = getNodeId(webSocket);

    let callerContext: CallerContext = { location, nodeId };

    let retriesEnabled = location.listeningPorts.length === 0;
    
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
                tryToReconnect();
            }
        }
    }

    let reconnectingPromise: Promise<void>|undefined;
    let reconnectAttempts = 0;
    
    function tryToReconnect() {
        if (reconnectingPromise) return;
        reconnectingPromise = (async () => {
            while(true) {
                let ports = location.listeningPorts;
                let port = ports[reconnectAttempts % ports.length];
                webSocket = new ws.WebSocket(`ws://${location.address}:${port}`);

                setupWebsocket();

                let connectError = await new Promise<string|undefined>(resolve => {
                    webSocket.on("open", () => {
                        resolve(undefined);
                    });
                    webSocket.on("close", () => {
                        resolve("Connection closed for non-error reason?");
                    });
                    webSocket.on("error", e => {
                        resolve(String(e.stack));
                    });
                });

                let newNodeId = getNodeId(webSocket);
                if (newNodeId !== nodeId) {
                    throw new Error(`Connection lost to at ${niceConnectionName} ("${nodeId}"), but then re-established, however it is now "${newNodeId}"!`);
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
        })();
    }

    function setupWebsocket() {
        webSocket.on("error", e => {
            console.log(`Websocket error for ${niceConnectionName}`, e);
        });
    
        webSocket.on("close", tryToReconnect);
    
        webSocket.on("message", onMessage);
    }

    
    let pendingCalls: Map<number, (result: InternalReturnType) => void> = new Map();
    // NOTE: It is important to make this as random as possible, to prevent
    //  reconnections dues to a process being reset causing seqNum collisions
    //  in return calls.
    let nextSeqNum = Math.random();

    setupWebsocket();
    

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
        nodeId,
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