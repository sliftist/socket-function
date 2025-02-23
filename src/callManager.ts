/// <reference path="../hot/HotReloadController.ts" />
import { CallerContext, CallType, ClientHookContext, FullCallType, FunctionFlags, HookContext, SocketExposedInterface, SocketExposedInterfaceClass, SocketExposedShape, SocketFunctionClientHook, SocketFunctionHook, SocketRegistered } from "../SocketFunctionTypes";
import { _setSocketContext } from "../SocketFunction";
import { entries, isNode } from "./misc";
import debugbreak from "debugbreak";
import { measureWrap } from "./profiling/measure";
import { formatTime } from "./formatting/format";

let classes: {
    [classGuid: string]: {
        controller: SocketExposedInterface;
        shape: SocketExposedShape;
    }
} = {};
let exposedClasses = new Set<string>();

let globalHooks: SocketFunctionHook[] = [];
let globalClientHooks: SocketFunctionClientHook[] = [];

export function getCallFlags(call: CallType): FunctionFlags | undefined {
    return classes[call.classGuid]?.shape[call.functionName];
}
export function shouldCompressCall(call: CallType) {
    return !!classes[call.classGuid]?.shape[call.functionName]?.compress;
}

export async function performLocalCall(
    config: {
        call: FullCallType;
        caller: CallerContext;
    }
): Promise<unknown> {
    const { call, caller } = config;
    let classDef = classes[call.classGuid];

    if (!classDef) {
        throw new Error(`Class ${call.classGuid} not found. Have ${Object.keys(classes).join(", ")}`);
    }

    if (!exposedClasses.has(call.classGuid)) {
        throw new Error(`Class ${call.classGuid} not exposed, exposed classes: ${Array.from(exposedClasses).join(", ")}`);
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
        for (let callback of serverContext.onResult) {
            await callback(serverContext.overrideResult);
        }
        if ("overrideResult" in serverContext) {
            return serverContext.overrideResult;
        }
    }

    // NOTE: We purposely don't await inside _setSocketContext, so the context is reset synchronously
    let result = _setSocketContext(caller, () => {
        return controller[call.functionName](...call.args);
    });
    for (let callback of serverContext.onResult) {
        await callback(result);
    }

    if ("overrideResult" in serverContext) {
        return serverContext.overrideResult;
    }
    return await result;
}

export function isDataImmutable(call: CallType) {
    return !!classes[call.classGuid]?.shape[call.functionName]?.dataImmutable;
}

export function registerClass(classGuid: string, controller: SocketExposedInterface, shape: SocketExposedShape, config?: {
    noFunctionMeasure?: boolean;
}) {
    if (!globalThis.isHotReloading?.() && classes[classGuid]) {
        throw new Error(`Class ${classGuid} already registered`);
    }

    if (!config?.noFunctionMeasure) {
        let keys = new Set([
            ...Object.keys(controller),
            ...Object.getOwnPropertyNames(controller.__proto__ || {}),
        ]);
        let niceClassName = controller.constructor.name || classGuid;
        for (let functionName of keys) {
            if (functionName === "constructor") continue;
            let fnc = controller[functionName];
            if (typeof fnc !== "function") continue;
            controller[functionName] = measureWrap(fnc, `${niceClassName}().${functionName}`);
        }
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
    hooks: Exclude<SocketExposedShape[""], undefined>,
    connectionId: { nodeId: string },
): Promise<ClientHookContext> {
    let context: ClientHookContext = { call: callType, connectionId, onResult: [] };

    let clientHooks = hooks.clientHooks?.slice() || [];
    if (!hooks.noClientHooks) {
        clientHooks = globalClientHooks.concat(clientHooks);
        for (let otherClientHook of globalHooks.concat(hooks.hooks || []).map(x => x.clientHook)) {
            if (otherClientHook) {
                clientHooks.push(otherClientHook);
            }
        }
    }
    for (let hook of clientHooks) {
        let time = Date.now();
        await hook(context);
        time = Date.now() - time;
        if (time > 100) {
            console.warn(`Slow (${formatTime(time)}) client hook: ${JSON.stringify(hook.name || hook.toString().slice(0, 100))} for ${callType.classGuid}.${callType.functionName}(...)`);
        }
        // NOTE: See ClientHookContext.overrideResult for why we break here
        if ("overrideResult" in context) {
            break;
        }
    }

    return context;
});

export const runServerHooks = measureWrap(async function runServerHooks(
    callType: FullCallType,
    caller: CallerContext,
    hooks: Exclude<SocketExposedShape[""], undefined>,
): Promise<HookContext> {
    let hookContext: HookContext = { call: callType, onResult: [] };
    for (let hook of globalHooks.concat(hooks.hooks || [])) {
        let time = Date.now();
        await _setSocketContext(caller, () => hook(hookContext));
        time = Date.now() - time;
        if (time > 100) {
            console.warn(`Slow (${formatTime(time)}) server hook: ${JSON.stringify(hook.name || hook.toString().slice(0, 100))} for ${callType.classGuid}.${callType.functionName}(...)`);
        }
        // NOTE: See HookContext.overrideResult for why we don't break here
    }
    return hookContext;
});