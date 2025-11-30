/// <reference types="node" />
/// <reference types="node" />
/// <reference types="node" />
import { CallType } from "../SocketFunctionTypes";
import * as ws from "ws";
import * as tls from "tls";
export interface CallFactory {
    nodeId: string;
    lastClosed: number;
    closedForever?: boolean;
    isConnected?: boolean;
    performCall(call: CallType): Promise<unknown>;
    onNextDisconnect(callback: () => void): void;
    connectionId: {
        nodeId: string;
    };
}
export interface SenderInterface {
    nodeId?: string;
    _socket?: tls.TLSSocket;
    send(data: string | Buffer): void;
    addEventListener(event: "open", listener: () => void): void;
    addEventListener(event: "close", listener: () => void): void;
    addEventListener(event: "error", listener: (err: {
        message: string;
    }) => void): void;
    addEventListener(event: "message", listener: (data: ws.RawData | ws.MessageEvent | string) => void): void;
    readyState: number;
    ping?(): void;
}
export declare function harvestFailedCallCount(): number;
export declare function getPendingCallCount(): number;
export declare function harvestCallTimes(): {
    start: number;
    end: number;
}[];
export declare function createCallFactory(webSocketBase: SenderInterface | undefined, nodeId: string, localNodeId?: string): Promise<CallFactory>;
