/// <reference path="./require/RequireController.ts" />

module.allowclient = true;

import { SocketFunction } from "./SocketFunction";
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
export type FunctionFlags = {
    compress?: boolean;

    /** Indicates with the same input, we give the same output, forever,
     *      independent of code changes. This only works for data storage.
     */
    dataImmutable?: boolean;

    /** Allows overriding SocketFunction.MAX_MESSAGE_SIZE for responses from this function. */
    responseLimit?: number;
};
export type SocketExposedShape<ExposedType extends SocketExposedInterface = SocketExposedInterface> = {
    [functionName in keyof ExposedType]?: FunctionFlags & {
        hooks?: SocketFunctionHook<ExposedType>[];
        clientHooks?: SocketFunctionClientHook<ExposedType>[];
        noDefaultHooks?: boolean;
        noClientHooks?: boolean;
    };
};

export interface CallType {
    classGuid: string;
    functionName: string;
    args: unknown[];
}
export interface FullCallType extends CallType {
    nodeId: string;
}

export interface SocketFunctionHook<ExposedType extends SocketExposedInterface = SocketExposedInterface> {
    (config: HookContext<ExposedType>): MaybePromise<void>;
    /** NOTE: This is useful when we need a clientside hook to set up state specifically for our serverside hook. */
    clientHook?: SocketFunctionClientHook<ExposedType>;
}
export type HookContext<ExposedType extends SocketExposedInterface = SocketExposedInterface> = {
    call: FullCallType;
    // If the result is overriden, we continue evaluating hooks BUT DO NOT perform the final call
    overrideResult?: unknown;
};

export type ClientHookContext<ExposedType extends SocketExposedInterface = SocketExposedInterface> = {
    call: FullCallType;
    // If the result is overriden, we continue evaluating hooks BUT DO NOT perform the final call
    overrideResult?: unknown;
    connectionId: { nodeId: string };
};
export interface SocketFunctionClientHook<ExposedType extends SocketExposedInterface = SocketExposedInterface> {
    (config: ClientHookContext<ExposedType>): MaybePromise<void>;
}

export interface SocketRegistered<ExposedType = any> {
    nodes: {
        // NOTE: Don't pass around nodeId to other nodes, instead pass around NetworkLocation (which they
        //  then turn into a nodeId, which they can then check permissions on themself).
        [nodeId: string]: {
            [functionName in keyof ExposedType]: ExposedType[functionName] & {
                [getCallObj]: (...args: Args<ExposedType[functionName]>) => FullCallType;
            }
        };
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
    //  IF they are the server, calling us back, then this will just be ""
    localNodeId: string;
};