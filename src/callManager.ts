import { CallContextType, CallerContext, CallType, ClientHookContext, FullCallType, HookContext, SocketExposedInterface, SocketExposedInterfaceClass, SocketExposedShape, SocketFunctionClientHook, SocketFunctionHook, SocketRegistered } from "../SocketFunctionTypes";
import { _setSocketContext } from "../SocketFunction";
import { isNode } from "./misc";

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
    callType: FullCallType,
    hooks: SocketExposedShape[""],
): Promise<ClientHookContext> {
    let context: ClientHookContext = { call: callType };
    // NOTE: These defaults are important, or else calls can just lock up forever
    //  - Any calls that do work should greatly extend the callTimeout (probably to an hour, at least). But,
    //      most of our calls don't, so they should REALLY be completing with a minute. Also,
    //      generally speaking nothing is so important that we need to spend more than 30 seconds reconnecting
    //      to make the call
    if (isNode()) {
        context.callTimeout = 1000 * 60 * 1;
        context.call.reconnectTimeout = 1000 * 30;
    } else {
        // MUST longer timeouts in the browser, as it is a lot easier for your phone to lose internet connectivity
        //  for a few minutes, AND, the browser will have a lot of local state (textboxes, etc), that we really don't
        //  want to lose. Also, a server doesn't mind restarting a process, but a user WILL mind having to refresh a page.
        context.callTimeout = 1000 * 60 * 15;
        context.call.reconnectTimeout = 1000 * 60 * 5;
    }

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
}

async function runServerHooks(
    callType: FullCallType,
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