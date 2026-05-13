/// <reference types="node" />
/// <reference types="node" />
/// <reference types="node" />
import { CallType } from "../SocketFunctionTypes";
import * as ws from "ws";
import * as tls from "tls";
export interface CallFactory {
    nodeId: string;
    realNodeId?: string;
    lastClosed: number;
    closedForever?: boolean;
    isConnected?: boolean;
    receivedInitializeState?: InitializeState;
    protocolNegotiated?: boolean;
    performCall(call: CallType): Promise<unknown>;
    onNextDisconnect(callback: () => void): void;
    disconnect(): void;
    connectionId: {
        nodeId: string;
    };
}
export interface SenderInterface {
    nodeId?: string;
    _socket?: tls.TLSSocket;
    protocol?: string;
    send(data: string | Buffer): void;
    close(): void;
    addEventListener(event: "open", listener: () => void): void;
    addEventListener(event: "close", listener: () => void): void;
    addEventListener(event: "error", listener: (err: {
        message: string;
    }) => void): void;
    addEventListener(event: "message", listener: (data: ws.RawData | ws.MessageEvent | string) => void): void;
    readyState: number;
    ping?(): void;
}
type InitializeState = {
    supportsLZ4?: boolean;
};
export declare function harvestFailedCallCount(): number;
export declare function getPendingCallCount(): number;
export declare function harvestCallTimes(): {
    start: number;
    end: number;
}[];
export declare function createCallFactory(webSocketBase: SenderInterface | undefined, nodeId: string, localNodeId?: string): Promise<CallFactory>;
export {};
