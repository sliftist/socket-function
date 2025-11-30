import { FullCallType, SocketInternalInterface } from "../SocketFunctionTypes";
type CallProxyType = {
    [nodeId: string]: SocketInternalInterface;
};
export declare const getCallObj: unique symbol;
export declare function getCallProxy(id: string, callback: (callType: FullCallType) => Promise<unknown>): CallProxyType;
export {};
