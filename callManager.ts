import { CallContextType, CallerContext, CallType, ClientHookContext, HookContext, NetworkLocation, SocketExposedInterface, SocketExposedInterfaceClass, SocketExposedShape, SocketFunctionClientHook, SocketFunctionHook, SocketRegistered } from "./SocketFunctionTypes";
import { _setSocketContext } from "./SocketFunction";

let classes: {
    [classGuid: string]: {
        classType: SocketExposedInterfaceClass;
        controller: SocketExposedInterface;
        shape: SocketExposedShape;
    }
} = {};
let exposedClasses = new Set<SocketExposedInterfaceClass>();

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

    if (!exposedClasses.has(classDef.classType)) {
        throw new Error(`Class ${call.classGuid} not exposed`);
    }

    let controller = classDef.controller;
    let shape = classDef.shape;
    let functionShape = shape[call.functionName];
    if (!functionShape) {
        throw new Error(`Function ${call.functionName} not exposed`);
    }

    if (!controller[call.functionName]) {
        throw new Error(`Function ${call.functionName} does not exist`);
    }

    let curContext: CallContextType = {};
    let serverContext = await runServerHooks(call, { caller, curContext }, shape);
    if ("overrideResult" in serverContext) {
        return serverContext.overrideResult;
    }

    // NOTE: We purposely don't await inside _setSocketContext, so the context is reset synchronously
    let result = _setSocketContext(curContext, caller, () => {
        return controller[call.functionName](...call.args);
    });

    return await result;
}

export function registerClass(classGuid: string, exposedClass: SocketExposedInterfaceClass, shape: SocketExposedShape) {
    if (classes[classGuid]) {
        throw new Error(`Class ${classGuid} already registered`);
    }

    classes[classGuid] = {
        classType: exposedClass,
        controller: new exposedClass() as SocketExposedInterface,
        shape,
    };
}

export function exposeClass(exposedClass: SocketExposedInterfaceClass) {
    exposedClasses.add(exposedClass);
}

export function registerGlobalHook(hook: SocketFunctionHook) {
    globalHooks.push(hook);
}
export function registerGlobalClientHook(hook: SocketFunctionClientHook) {
    globalClientHooks.push(hook);
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