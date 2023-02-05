/// <reference path="./require/RequireController.ts" />

module.allowclient = true;

import { getCallObj } from "./src/nodeProxy";
import { Args, MaybePromise } from "./src/types";

export const socket = Symbol("socket");

export type SocketExposedInterface = {
    [functionName: string]: (...args: any[]) => Promise<unknown>;
};
export type SocketInternalInterface = {
    [functionName: string]: {
        [getCallObj]: (...args: any[]) => FullCallType;
        (...args: any[]): Promise<unknown>;
    }
}
export type SocketExposedInterfaceClass = {
    //new(): SocketExposedInterface;
    new(): unknown;
    prototype: unknown;
};
export interface SocketExposedShape<ExposedType extends SocketExposedInterface = SocketExposedInterface, CallContext extends CallContextType = CallContextType> {
    [functionName: string]: {
        /** Indicates with the same input, we give the same output, forever,
         *      independent of code changes. This only works for data storage.
         */
        dataImmutable?: boolean;
        hooks?: SocketFunctionHook<ExposedType, CallContext>[];
        clientHooks?: SocketFunctionClientHook<ExposedType, CallContext>[];
    };
}

export interface CallType {
    classGuid: string;
    functionName: string;
    args: unknown[];
    // NOTE: When making calls this needs to be set in the client hook.
    //  To set a timeout on returns, you can set it in the server hook.
    reconnectTimeout?: number;
}
export interface FullCallType extends CallType {
    nodeId: string;
}

export interface SocketFunctionHook<ExposedType extends SocketExposedInterface = SocketExposedInterface, CallContext extends CallContextType = CallContextType> {
    (config: HookContext<ExposedType, CallContext>): MaybePromise<void>;
    /** NOTE: This is useful when we need a clientside hook to set up state specifically for our serverside hook. */
    clientHook?: SocketFunctionClientHook<ExposedType, CallContext>;
}
export type HookContext<ExposedType extends SocketExposedInterface = SocketExposedInterface, CallContext extends CallContextType = CallContextType> = {
    call: FullCallType;
    context: SocketRegistered<ExposedType, CallContext>["context"];
    // If the result is overriden, we continue evaluating hooks BUT DO NOT perform the final call
    overrideResult?: unknown;
};

export type ClientHookContext<ExposedType extends SocketExposedInterface = SocketExposedInterface, CallContext extends CallContextType = CallContextType> = {
    call: FullCallType;
    /** If the calls takes longer than this (for ANY reason), we return with an error.
     *      - Different from reconnectTimeout, which only errors if we lose the connection.
    */
    callTimeout?: number;
    // If the result is overriden, we continue evaluating hooks BUT DO NOT perform the final call
    overrideResult?: unknown;
};
export interface SocketFunctionClientHook<ExposedType extends SocketExposedInterface = SocketExposedInterface, CallContext extends CallContextType = CallContextType> {
    (config: ClientHookContext<ExposedType, CallContext>): MaybePromise<void>;
}

export type CallContextType = {
    [key: string]: unknown;
};

export interface SocketRegistered<ExposedType = any, DynamicCallContext extends CallContextType = CallContextType> {
    nodes: {
        // NOTE: Don't pass around nodeId to other nodes, instead pass around NetworkLocation (which they
        //  then turn into a nodeId, which they can then check permissions on themself).
        [nodeId: string]: {
            [functionName in keyof ExposedType]: ExposedType[functionName] & {
                [getCallObj]: (...args: Args<ExposedType[functionName]>) => FullCallType;
            }
        };
    };
    context: {
        // If undefined we are not synchronously in a call
        curContext: DynamicCallContext | undefined;
        caller: CallerContext | undefined;
        getCaller(): CallerContext;
    };
    _classGuid: string;
}
export type CallerContext = Readonly<CallerContextBase>;
export type CallerContextBase = {
    // IMPORTANT! Do not pass nodeId to other nodes with the intention of having
    //  them call functions directly using nodeId. Instead pass location, and have them use connect.
    //  - nodeId will be unique per thread, so is only useful for temporary communcation. If you want
    //      a more permanent identity, you must derive it from certInfo yourself.
    nodeId: string;

    // The nodeId they contacted. This is useful to determine their intention (otherwise
    //  requests can be redirected to us and would accept them, even though they are being
    //  blatantly MITMed).
    localNodeId: string;
};