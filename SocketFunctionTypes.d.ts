/// <reference path="require/RequireController.d.ts" />
import { getCallObj } from "./src/nodeProxy";
import { Args, MaybePromise } from "./src/types";
export declare const socket: unique symbol;
export type SocketExposedInterface = {
    [functionName: string]: (...args: any[]) => Promise<unknown>;
};
export type SocketInternalInterface = {
    [functionName: string]: {
        [getCallObj]: (...args: any[]) => FullCallType;
        (...args: any[]): Promise<unknown>;
    };
};
export type SocketExposedInterfaceClass = {
    new (): unknown;
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
    overrideResult?: unknown;
    onResult: ((result: unknown) => MaybePromise<void>)[];
};
export type ClientHookContext = {
    call: FullCallType;
    overrideResult?: unknown;
    onResult: ((result: unknown) => MaybePromise<void>)[];
    connectionId: {
        nodeId: string;
    };
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
        [nodeId: string]: {
            [functionName in keyof ExposedType]: ExposedType[functionName] & {
                [getCallObj]: (...args: Args<ExposedType[functionName]>) => FullCallType;
            };
        };
    };
    _classGuid: string;
    _internalType: ExposedType;
}
export type ControllerPick<T extends SocketRegistered, K extends keyof T["_internalType"]> = (SocketRegistered<Pick<T["_internalType"], K>>);
export type CallerContext = Readonly<CallerContextBase>;
export type CallerContextBase = {
    nodeId: string;
    localNodeId: string;
};
