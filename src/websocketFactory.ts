import ws from "ws";
import tls from "tls";
import { isNode } from "./misc";
import { SenderInterface } from "./CallFactory";
import { getTrustedCertificates } from "./certStore";
import { getNodeIdLocation } from "./nodeCache";
import debugbreak from "debugbreak";
import { SocketFunction } from "../SocketFunction";

export function getTLSSocket(webSocket: ws.WebSocket) {
    return (webSocket as any)._socket as tls.TLSSocket;
}

/** NOTE: We create a factory, which embeds the key/cert information. Otherwise retries might use
 *      a different key/cert context.
 */
export function createWebsocketFactory(): (nodeId: string) => SenderInterface {

    if (!isNode()) {
        return (nodeId: string) => {
            let location = getNodeIdLocation(nodeId);
            if (!location) throw new Error(`Cannot connect to ${nodeId}, no address known`);
            let { address, port } = location;

            if (!SocketFunction.silent) {
                console.log(`Connecting to ${address}:${port}`);
            }
            return new WebSocket(`wss://${address}:${port}`);
        };
    } else {
        return (nodeId: string) => {
            let location = getNodeIdLocation(nodeId);
            if (!location) throw new Error(`Cannot connect to ${nodeId}, no address known`);
            let { address, port } = location;

            if (!SocketFunction.silent) {
                console.log(`Connecting to ${address}:${port}`);
            }
            let webSocket = new ws.WebSocket(`wss://${address}:${port}`, undefined, {
                ca: getTrustedCertificates(),
            });

            // NOTE: Little setup is done here, because Sometimes websockets are created here,
            //      and sometimes via incoming connections, We should do most setup in
            //      CallFactory.ts:initializeWebsocket

            return webSocket;
        };
    }
}

