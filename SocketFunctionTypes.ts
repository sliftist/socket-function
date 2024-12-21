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
        // NOTE: Due tohow register is called we can't use ExposedType[functionName] here,
        //  because we didn'tt use the double call pattern. Maybe we will later,
        //  but the type benefits are marginal. Args and overrideResult can be typed,
        //  but 99% of the time those are used by generic helper functions anyways,
        //  which only want unknowns anyways.
        hooks?: SocketFunctionHook[];
        clientHooks?: SocketFunctionClientHook[];
        noDefaultHooks?: boolean;
        /** BUG: I think this is broken if it is on the default hooks function? */
        noClientHooks?: boolean;
    };
};

export type FncType = (...args: any[]) => Promise<unknown>;
export interface CallType<FncT extends FncType = FncType, FncName extends string = string> {
    classGuid: string;
    functionName: FncName;
    args: unknown[];
}
export interface FullCallType<FncT extends FncType = FncType, FncName extends string = string> extends CallType<FncT, FncName> {
    nodeId: string;
}

export interface SocketFunctionHook {
    (config: HookContext): MaybePromise<void>;
    /** NOTE: This is useful when we need a clientside hook to set up state specifically for our serverside hook. */
    clientHook?: SocketFunctionClientHook;
}
export type HookContext = {
    call: FullCallType;
    // If the result is overriden, we continue evaluating hooks BUT DO NOT perform the final call
    //  - It is important we continue evaluating hooks, in case some later hooks check permissions
    //      and throw. We wouldn't want a caching layer to accidentally avoid a permissions check.
    overrideResult?: unknown;
    // Is called on a result, even if it is from overrideResult
    //  Maybe further mutate overrideResult, or even add it
    onResult: ((result: unknown) => MaybePromise<void>)[];
};

export type ClientHookContext = {
    call: FullCallType;
    // If the result is overriden, we STOP evaluating hooks and do not perform the final call
    //  - We stop evaluating hooks, because other hooks might end up making unnecessary calls,
    //      which won't be needed, because we aren't calling the server. There is no security issue,
    //      because the clientside checks are never security checks (how could they be, the client
    //      can't authorize itself...)
    overrideResult?: unknown;
    // Is called on a result, even if it is from overrideResult
    onResult: ((result: unknown) => MaybePromise<void>)[];
    connectionId: { nodeId: string };
};
export interface SocketFunctionClientHook {
    (config: ClientHookContext): MaybePromise<void>;
}

export interface SocketRegisterType<ExposedType = any> {
    _classGuid: string;
    _internalType: ExposedType;
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
    _internalType: ExposedType;
}
export type ControllerPick<T extends SocketRegistered, K extends keyof T["_internalType"]> = (
    SocketRegistered<Pick<T["_internalType"], K>>
);
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