/// <reference types="node" />
/// <reference types="node" />
/// <reference types="node" />
import http from "http";
import { CallType } from "../SocketFunctionTypes";
export declare function setDefaultHTTPCall(call: CallType): void;
export declare function getServerLocationFromRequest(request: http.IncomingMessage): {
    address: string;
    port: number;
};
export declare function getNodeIdsFromRequest(request: http.IncomingMessage): {
    nodeId: string;
    localNodeId: string;
};
export declare function getCurrentHTTPRequest(): http.IncomingMessage | undefined;
export declare function httpCallHandler(request: http.IncomingMessage, response: http.ServerResponse): Promise<void>;
declare const resultHeaders: unique symbol;
type HTTPResultType = Buffer & {
    [resultHeaders]?: {
        [header: string]: string;
    };
};
export declare function setHTTPResultHeaders(result: HTTPResultType, headers: {
    [header: string]: string;
}): HTTPResultType;
export {};
