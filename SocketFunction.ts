/// <reference path="./require/RequireController.ts" />

import { SocketExposedInterface, CallContextType, SocketFunctionHook, SocketFunctionClientHook, SocketExposedShape, SocketRegistered, CallerContext, FullCallType } from "./SocketFunctionTypes";
import { exposeClass, registerClass, registerGlobalClientHook, registerGlobalHook, runClientHooks } from "./src/callManager";
import { SocketServerConfig, startSocketServer } from "./src/webSocketServer";
import { getCreateCallFactoryLocation, getNodeId, getNodeIdLocation } from "./src/nodeCache";
import { getCallProxy } from "./src/nodeProxy";
import { Args, MaybePromise } from "./src/types";
import { setDefaultHTTPCall } from "./src/callHTTPHandler";
import debugbreak from "debugbreak";
import { lazy } from "./src/caching";

module.allowclient = true;

type ExtractShape<ClassType, Shape> = {
    [key in keyof Shape]: (
        key extends keyof ClassType
        ? ClassType[key] extends SocketExposedInterface[""]
        ? ClassType[key]
        : ClassType[key] extends Function ? "All exposed function must be async (or return a Promise)" : never
        : "Function is in shape, but not in class"
    );
};
// https://stackoverflow.com/a/69756175/1117119
type PickByType<T, Value> = {
    [P in keyof T as T[P] extends Value | undefined ? P : never]: T[P]
};

export class SocketFunction {
    public static logMessages = false;
    public static compression: undefined | {
        type: "gzip";
    };
    public static httpETagCache = false;

    private static onMountCallbacks = new Map<string, (() => MaybePromise<void>)[]>();
    public static exposedClasses = new Set<string>();

    // NOTE: We use callbacks we don't run into issues with cyclic dependencies
    //  (ex, using a hook in a controller where the hook also calls the controller).
    public static register<
        ClassInstance extends object,
        Shape extends SocketExposedShape<SocketExposedInterface, CallContext>,
        CallContext extends CallContextType
    >(
        classGuid: string,
        instance: ClassInstance,
        shapeFnc: () => Shape,
        defaultHooksFnc?: () => SocketExposedShape[""] & {
            onMount?: () => MaybePromise<void>;
        }
    ): SocketRegistered<ExtractShape<ClassInstance, Shape>, CallContext> {
        let getDefaultHooks = defaultHooksFnc && lazy(defaultHooksFnc);
        const getShape = lazy(() => {
            let shape = shapeFnc();
            let defaultHooks = getDefaultHooks?.();

            for (let value of Object.values(shape)) {
                if (!value) continue;
                value.clientHooks = [...(defaultHooks?.clientHooks || []), ...(value.clientHooks || [])];
                value.hooks = [...(defaultHooks?.hooks || []), ...(value.hooks || [])];
                value.dataImmutable = defaultHooks?.dataImmutable ?? value.dataImmutable;
            }
            return shape as any as SocketExposedShape;
        });

        setImmediate(() => {
            registerClass(classGuid, instance as SocketExposedInterface, getShape());
        });

        let nodeProxy = getCallProxy(classGuid, async (call) => {
            let nodeId = call.nodeId;
            let functionName = call.functionName;
            let time = Date.now();
            if (SocketFunction.logMessages) {
                console.log(`START\t\t\t${classGuid}.${functionName}`);
            }
            try {
                let callFactory = await getCreateCallFactoryLocation(nodeId, SocketFunction.mountedNodeId);

                let shapeObj = getShape()[functionName];
                if (!shapeObj) {
                    throw new Error(`Function ${functionName} is not in shape`);
                }

                let hookResult = await runClientHooks(call, shapeObj as SocketExposedShape[""]);

                if ("overrideResult" in hookResult) {
                    return hookResult.overrideResult;
                }

                return await callFactory.performCall(call);
            } finally {
                time = Date.now() - time;
                if (SocketFunction.logMessages) {
                    console.log(`TIME\t${time}ms\t${classGuid}.${functionName}`);
                }
            }
        });

        let output: SocketRegistered = {
            context: curSocketContext,
            nodes: nodeProxy,
            _classGuid: classGuid,
        };

        setImmediate(() => {
            let onMount = getDefaultHooks?.().onMount;
            if (onMount) {
                let callbacks = SocketFunction.onMountCallbacks.get(classGuid);
                if (!callbacks) {
                    callbacks = [];
                    SocketFunction.onMountCallbacks.set(classGuid, callbacks);
                }
                callbacks.push(onMount);
            }
        });

        return output as any;
    }

    /** NOTE: Only works if the nodeIs used is from SocketFunction.connect (we can't convert arbitrary nodeIds into urls,
     *      as we have no way of knowing how to contain a nodeId).
     *  */
    public static getHTTPCallLink(call: FullCallType): string {
        let location = getNodeIdLocation(call.nodeId);
        if (!location) {
            throw new Error(`Cannot find call location for nodeId, and so do not know where call location is. NodeId ${call.nodeId}`);
        }
        let url = new URL(`https://${location.address}:${location.port}`);
        url.searchParams.set("classGuid", call.classGuid);
        url.searchParams.set("functionName", call.functionName);
        url.searchParams.set("args", JSON.stringify(call.args));
        return url.toString();
    }

    /** Expose should be called before your mounting occurs. It mostly just exists to ensure you include the class type,
     *      so the class type's module construction runs, which should trigger register. Otherwise you would have
     *      to add additional imports to ensure the register call runs.
     */
    public static expose(socketRegistered: SocketRegistered) {
        exposeClass(socketRegistered);
        SocketFunction.exposedClasses.add(socketRegistered._classGuid);

        if (this.hasMounted) {
            let mountCallbacks = SocketFunction.onMountCallbacks.get(socketRegistered._classGuid);
            for (let onMount of mountCallbacks || []) {
                Promise.resolve(onMount()).catch(e => {
                    console.error("Error in onMount callback exposed after mount", e);
                });
            }
        }
    }

    public static mountedNodeId: string = "NOTMOUNTED";
    private static hasMounted = false;
    public static async mount(config: SocketServerConfig) {
        if (this.mountedNodeId !== "NOTMOUNTED") {
            throw new Error("SocketFunction already mounted, mounting twice in one thread is not allowed.");
        }
        this.mountedNodeId = await startSocketServer(config);
        this.hasMounted = true;
        for (let classGuid of SocketFunction.exposedClasses) {
            let callbacks = SocketFunction.onMountCallbacks.get(classGuid);
            if (!callbacks) continue;
            for (let callback of callbacks) {
                await callback();
            }
        }
        return this.mountedNodeId;
    }

    /** Sets the default call when an http request is made, but no classGuid is set. */
    public static setDefaultHTTPCall<
        Registered extends SocketRegistered,
        FunctionName extends keyof Registered["nodes"][""] & string,
    >(
        registered: Registered,
        functionName: FunctionName,
        ...args: Args<Registered["nodes"][""][FunctionName]>
    ) {
        setDefaultHTTPCall({
            classGuid: registered._classGuid,
            functionName,
            args,
        });
    }

    public static connect(location: { address: string, port: number }): string {
        return getNodeId(location.address, location.port);
    }

    public static addGlobalHook<CallContext extends CallContextType>(hook: SocketFunctionHook<SocketExposedInterface, CallContext>) {
        registerGlobalHook(hook as SocketFunctionHook);
    }
    public static addGlobalClientHook<CallContext extends CallContextType>(hook: SocketFunctionClientHook<SocketExposedInterface, CallContext>) {
        registerGlobalClientHook(hook as SocketFunctionClientHook);
    }
}


const curSocketContext: SocketRegistered["context"] = {
    curContext: undefined,
    caller: undefined,
    getCaller() {
        const caller = curSocketContext.caller;
        if (!caller) throw new Error(`Tried to access caller when not in the synchronous phase of a function call`);
        return caller;
    }
};
let socketContextSeqNum = 1;

export function _setSocketContext<T>(
    callContext: CallContextType,
    caller: CallerContext,
    code: () => T,
) {
    socketContextSeqNum++;
    let seqNum = socketContextSeqNum;
    curSocketContext.curContext = callContext;
    curSocketContext.caller = caller;
    try {
        return code();
    } finally {
        if (seqNum === socketContextSeqNum) {
            curSocketContext.curContext = undefined;
            curSocketContext.caller = undefined;
        }
    }
}