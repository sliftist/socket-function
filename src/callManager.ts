import { CallContextType, CallerContext, CallType, ClientHookContext, HookContext, SocketExposedInterface, SocketExposedInterfaceClass, SocketExposedShape, SocketFunctionClientHook, SocketFunctionHook, SocketRegistered } from "../SocketFunctionTypes";
import { _setSocketContext } from "../SocketFunction";

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
        call: CallType;
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

    let curContext: CallContextType = {};
    let serverContext = await runServerHooks(call, { caller, curContext, getCaller: () => caller }, functionShape);
    if ("overrideResult" in serverContext) {
        return serverContext.overrideResult;
    }

    // NOTE: We purposely don't await inside _setSocketContext, so the context is reset synchronously
    let result = _setSocketContext(curContext, caller, () => {
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

export async function runClientHooks(
    callType: CallType,
    hooks: SocketExposedShape[""],
): Promise<ClientHookContext> {
    let context: ClientHookContext = { call: callType };
    for (let hook of globalClientHooks.concat(hooks.clientHooks || [])) {
        await hook(context);
        if ("overrideResult" in context) {
            break;
        }
    }
    return context;
}

async function runServerHooks(
    callType: CallType,
    context: SocketRegistered["context"],
    hooks: SocketExposedShape[""],
): Promise<HookContext> {
    let hookContext: HookContext = { call: callType, context };
    for (let hook of globalHooks.concat(hooks.hooks || [])) {
        await hook(hookContext);
        if ("overrideResult" in hookContext) {
            break;
        }
    }
    return hookContext;
}