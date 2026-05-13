/// <reference types="node" />
import tls from "tls";
import { SenderInterface } from "./CallFactory";
import type * as ws from "ws";
export declare function getTLSSocket(webSocket: ws.WebSocket): tls.TLSSocket;
export type WebsocketFactory = (nodeId: string, proposedProtocols?: string[]) => SenderInterface;
/** NOTE: We create a factory, which embeds the key/cert information. Otherwise retries might use
 *      a different key/cert context.
 */
export declare function createWebsocketFactory(): WebsocketFactory;
