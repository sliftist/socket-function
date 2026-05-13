import tls from "tls";
import { isNode } from "./misc";
import { SenderInterface } from "./CallFactory";
import { getTrustedCertificates } from "./certStore";
import { getNodeIdLocation } from "./nodeCache";
import debugbreak from "debugbreak";
import { SocketFunction } from "../SocketFunction";
import type * as ws from "ws";

export function getTLSSocket(webSocket: ws.WebSocket) {
    return (webSocket as any)._socket as tls.TLSSocket;
}

export type WebsocketFactory = (nodeId: string, proposedProtocols?: string[]) => SenderInterface;

/** NOTE: We create a factory, which embeds the key/cert information. Otherwise retries might use
 *      a different key/cert context.
 */
export function createWebsocketFactory(): WebsocketFactory {

    if (!isNode()) {
        return (nodeId: string, proposedProtocols?: string[]) => {
            let location = getNodeIdLocation(nodeId);
            if (!location) throw new Error(`Cannot connect to ${nodeId}, no address known`);
            let { address, port } = location;

            if (!SocketFunction.silent) {
                console.log(`Connecting to ${address}:${port}`);
            }
            if (proposedProtocols && proposedProtocols.length > 0) {
                return new WebSocket(`wss://${address}:${port}`, proposedProtocols);
            }
            return new WebSocket(`wss://${address}:${port}`);
        };
    } else {
        return (nodeId: string, proposedProtocols?: string[]) => {
            let location = getNodeIdLocation(nodeId);
            if (!location) throw new Error(`Cannot connect to ${nodeId}, no address known`);
            let { address, port } = location;

            if (!SocketFunction.silent) {
                console.log(`Connecting to ${address}:${port}`);
            }
            const ws = require("ws") as typeof import("ws");
            let webSocket = new ws.WebSocket(`wss://${address}:${port}`, proposedProtocols, {
                ca: getTrustedCertificates(),
            });

            // NOTE: Little setup is done here, because Sometimes websockets are created here,
            //      and sometimes via incoming connections, We should do most setup in
            //      CallFactory.ts:initializeWebsocket

            return webSocket;
        };
    }
}
