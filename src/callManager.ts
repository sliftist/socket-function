import { CallerContext, CallType, ClientHookContext, FullCallType, HookContext, SocketExposedInterface, SocketExposedInterfaceClass, SocketExposedShape, SocketFunctionClientHook, SocketFunctionHook, SocketRegistered } from "../SocketFunctionTypes";
import { _setSocketContext } from "../SocketFunction";
import { isNode } from "./misc";
import debugbreak from "debugbreak";
import { measureWrap } from "./profiling/measure";

let classes: {
    [classGuid: string]: {
        controller: SocketExposedInterface;
        shape: SocketExposedShape;
    }
} = {};
let exposedClasses = new Set<string>();

let globalHooks: SocketFunctionHook[] = [];
let globalClientHooks: SocketFunctionClientHook[] = [];

export async function performLocalCall(
    config: {
        call: FullCallType;
        caller: CallerContext;
    }
): Promise<unknown> {
    const { call, caller } = config;
    let classDef = classes[call.classGuid];

    if (!classDef) {
        throw new Error(`Class ${call.classGuid} not found`);
    }

    if (!exposedClasses.has(call.classGuid)) {
        throw new Error(`Class ${call.classGuid} not exposed`);
    }

    let controller = classDef.controller;
    let functionShape = classDef.shape[call.functionName];
    if (!functionShape) {
        throw new Error(`Function ${call.functionName} not exposed`);
    }

    if (!controller[call.functionName]) {
        throw new Error(`Function ${call.functionName} does not exist`);
    }

    let serverContext = await runServerHooks(call, caller, functionShape);
    if ("overrideResult" in serverContext) {
        return serverContext.overrideResult;
    }

    // NOTE: We purposely don't await inside _setSocketContext, so the context is reset synchronously
    let result = _setSocketContext(caller, () => {
        return controller[call.functionName](...call.args);
    });

    return await result;
}

export function isDataImmutable(call: CallType) {
    return !!classes[call.classGuid]?.shape[call.functionName]?.dataImmutable;
}

export function registerClass(classGuid: string, controller: SocketExposedInterface, shape: SocketExposedShape) {
    if (classes[classGuid]) {
        throw new Error(`Class ${classGuid} already registered`);
    }

    classes[classGuid] = {
        controller,
        shape,
    };
}

export function exposeClass(exposedClass: SocketRegistered) {
    exposedClasses.add(exposedClass._classGuid);
}

export function registerGlobalHook(hook: SocketFunctionHook) {
    globalHooks.push(hook);
}
export function unregisterGlobalHook(hook: SocketFunctionHook) {
    let index = globalHooks.indexOf(hook);
    if (index >= 0) {
        globalHooks.splice(index, 1);
    }
}
export function registerGlobalClientHook(hook: SocketFunctionClientHook) {
    globalClientHooks.push(hook);
}
export function unregisterGlobalClientHook(hook: SocketFunctionClientHook) {
    let index = globalClientHooks.indexOf(hook);
    if (index >= 0) {
        globalClientHooks.splice(index, 1);
    }
}

export const runClientHooks = measureWrap(async function runClientHooks(
    callType: FullCallType,
    hooks: SocketExposedShape[""],
    connectionId: { nodeId: string },
): Promise<ClientHookContext> {
    let context: ClientHookContext = { call: callType, connectionId };

    let clientHooks = (
        globalClientHooks
            .concat(hooks.clientHooks || [])
    );
    for (let otherClientHook of globalHooks.concat(hooks.hooks || []).map(x => x.clientHook)) {
        if (otherClientHook) {
            clientHooks.push(otherClientHook);
        }
    }
    for (let hook of clientHooks) {
        await hook(context);
        if ("overrideResult" in context) {
            break;
        }
    }

    return context;
});

export const runServerHooks = measureWrap(async function runServerHooks(
    callType: FullCallType,
    caller: CallerContext,
    hooks: SocketExposedShape[""],
): Promise<HookContext> {
    let hookContext: HookContext = { call: callType };
    for (let hook of globalHooks.concat(hooks.hooks || [])) {
        await _setSocketContext(caller, () => hook(hookContext));
        if ("overrideResult" in hookContext) {
            break;
        }
    }
    return hookContext;
});