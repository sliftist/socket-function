/// <reference path="../hot/HotReloadController.d.ts" />
import { CallerContext, CallType, ClientHookContext, FullCallType, FunctionFlags, HookContext, SocketExposedInterface, SocketExposedShape, SocketFunctionClientHook, SocketFunctionHook, SocketRegistered } from "../SocketFunctionTypes";
export declare function getCallFlags(call: CallType): FunctionFlags | undefined;
export declare function shouldCompressCall(call: CallType): boolean;
export declare function performLocalCall(config: {
    call: FullCallType;
    caller: CallerContext;
}): Promise<unknown>;
export declare function isDataImmutable(call: CallType): boolean;
export declare function registerClass(classGuid: string, controller: SocketExposedInterface, shape: SocketExposedShape, config?: {
    noFunctionMeasure?: boolean;
}): void;
export declare function exposeClass(exposedClass: SocketRegistered): void;
export declare function registerGlobalHook(hook: SocketFunctionHook): void;
export declare function unregisterGlobalHook(hook: SocketFunctionHook): void;
export declare function registerGlobalClientHook(hook: SocketFunctionClientHook): void;
export declare function unregisterGlobalClientHook(hook: SocketFunctionClientHook): void;
export declare const runClientHooks: (callType: FullCallType, hooks: Exclude<SocketExposedShape[""], undefined>, connectionId: {
    nodeId: string;
}) => Promise<ClientHookContext>;
export declare const runServerHooks: (callType: FullCallType, caller: CallerContext, hooks: Exclude<SocketExposedShape[""], undefined>) => Promise<HookContext>;
