/// <reference path="./require/RequireController.ts" />

import { SocketExposedInterface, SocketFunctionHook, SocketFunctionClientHook, SocketExposedShape, SocketRegistered, CallerContext, FullCallType, CallType, FncType, SocketRegisterType } from "./SocketFunctionTypes";
import { exposeClass, registerClass, registerGlobalClientHook, registerGlobalHook, runClientHooks } from "./src/callManager";
import { SocketServerConfig, startSocketServer } from "./src/webSocketServer";
import { getCallFactory, getCreateCallFactory, getNodeId, getNodeIdLocation, isClientNodeId } from "./src/nodeCache";
import { getCallProxy } from "./src/nodeProxy";
import { Args, MaybePromise } from "./src/types";
import { setDefaultHTTPCall } from "./src/callHTTPHandler";
import debugbreak from "debugbreak";
import { lazy } from "./src/caching";
import { createSingleton, defineSingletonConfig } from "./src/createSingleton";
import { delay } from "./src/batching";
import { blue, magenta } from "./src/formatting/logColors";
import { JSONLACKS } from "./src/JSONLACKS/JSONLACKS";
import "./SetProcessVariables";
import cborx from "cbor-x";
import { setFlag } from "./require/compileFlags";
import { isNode } from "./src/misc";
import { getPendingCallCount, harvestCallTimes, harvestFailedCallCount } from "./src/CallFactory";
import { measureWrap } from "./src/profiling/measure";

setFlag(require, "cbor-x", "allowclient", true);
let cborxInstance = new cborx.Encoder({ structuredClone: true });
if (isNode()) {
    // Do not crash on unhandled errors. SocketFunction is made to run a webserver,
    //  which will run perfectly after 99.9% of errors. Crashing the process is
    //  not a good alternative to proper error log and notifications. Do you guys
    //  not get automated emails when unexpected errors are logged? I do.
    process.on("unhandledRejection", (e) => {
        console.error("Unhandled rejection" + ((e as any)?.stack || e));
    });
    process.on("uncaughtException", (e) => {
        console.error("Uncaught exception" + ((e as any)?.stack || e));
    });
}

module.allowclient = true;

// The active call's caller, plus a sequence number used to reset it synchronously (see
//  _setSocketContext). Shared across copies of this package, so SocketFunction.getCaller()
//  returns the right caller even when the call was set up by a different copy. See createSingleton.
const socketContext = createSingleton("SocketFunction.socketContext", 1, () => ({
    seqNum: 1,
    caller: undefined as CallerContext | undefined,
}));

type ExtractShape<ClassType, Shape> = {
    [key in keyof ClassType]: (
        key extends keyof Shape
        ? ClassType[key] extends SocketExposedInterface[""]
        ? ClassType[key]
        : ClassType[key] extends Function ? "All exposed function must be async (or return a Promise)" : never
        : "Function has implementation but is not exposed in the SocketFunction.register call"
    );
};

export class SocketFunction {


    // #region Shared config statics. EVERYTHING in this region (and nothing outside it) is redefined
    //  below the class by defineSingletonConfig, which replaces each property (via defineProperty)
    //  with accessors onto a singleton shared by every copy of this package - the inline values here
    //  are just the defaults.
    public static logMessages = false;
    public static trackMessageSizes = {
        upload: [] as ((size: number, nodeId: string) => void)[],
        download: [] as ((size: number, nodeId: string) => void)[],
        callTimes: [] as ((obj: { start: number; end: number; nodeId: string; }) => void)[],
    };

    public static MAX_MESSAGE_SIZE = 1024 * 1024 * 32;

    public static HTTP_ETAG_CACHE = false;
    public static silent = true;

    public static HTTP_COMPRESS = false;

    // If you have HTTP resources that require cookies you might to set `SocketFunction.COEP = "require-corp"`
    //  - Cross-origin-resource-policy.
    public static COEP = "credentialless";
    // NOTE: This COOP and COEP defaults are required so window.crossOriginIsolated will be true.
    public static COOP = "same-origin";

    public static TOTAL_CALLS = 0;

    public static ENABLE_CLIENT_MODE = false;

    // In retrospect... dynamically changing the wire serializer is a BAD idea. If any calls happen
    //  before it is changed, things just break. Also, it needs to be changed on both sides,
    //  or else things break. Also, it is very hard to detect when the issue is different serializers
    // NOTE: The only reason this is still exposed is in case in the future we want to intercept our traffic, and we want convenient functions to know how to decode it (although there are a still few other layers under this, for compression and Buffer[] sending efficiency).
    public static readonly WIRE_SERIALIZER = {
        serialize: measureWrap((obj: unknown): MaybePromise<Buffer[]> => [cborxInstance.encode(obj)], "WIRE_SERIALIZER|serialize"),
        deserialize: measureWrap((buffers: Buffer[]): MaybePromise<unknown> => cborxInstance.decode(buffers[0]), "WIRE_SERIALIZER|deserialize"),
    };

    /** We will try the alternate node IDs first, however, if they fail, we will go through all of them and then eventually try the original node ID.
     *      VERY useful, allowing us to change global ips to local ones, which short-circuits the router, massively increasing bandwidth and decreasing latency.
     */
    public static GET_ALTERNATE_NODE_IDS = (nodeId: string): MaybePromise<string[] | undefined> => undefined;

    public static WIRE_WARN_TIME = 100;

    // Process-wide compression kill switch. When set before connections are established, LZ4 is left out of the protocol negotiation entirely (both for connections we initiate and ones we accept), so NEITHER side compresses — the wire format stays the plain backwards-compatible one. Overrides per-function `compress` flags.
    public static DISABLE_COMPRESSION = false;
    // #endregion Shared config statics.




    // Places where we decide if we want to act as a client. Most places we check for is node, but some places it's not, depending on if we're in Node.js or not, it's depending on if we're a client or not.
    public static isClient() { return !isNode() || SocketFunction.ENABLE_CLIENT_MODE; }

    // Shared across copies of this package, so onMount callbacks registered through one copy still
    //  fire when another copy mounts. See createSingleton.
    private static onMountCallbacks = createSingleton("SocketFunction.onMountCallbacks", 1, () => new Map<string, (() => MaybePromise<void>)[]>()).get();
    // Shared across copies of this package, so the set of exposed classes is consistent regardless
    //  of which copy a class was exposed through. See createSingleton.
    private static exposedClassesSingleton = createSingleton("SocketFunction.exposedClasses", 1, () => new Set<string>());
    public static get exposedClasses() { return SocketFunction.exposedClassesSingleton.get(); }

    public static get callerContext(): CallerContext | undefined { return socketContext.get().caller; }
    public static set callerContext(value: CallerContext | undefined) { socketContext.get().caller = value; }
    public static getCaller(): CallerContext {
        const caller = SocketFunction.callerContext;
        if (!caller) throw new Error(`Tried to access caller when not in the synchronous phase of a function call`);
        return caller;
    }

    public static harvestFailedCallCount = () => harvestFailedCallCount();
    public static getPendingCallCount = () => getPendingCallCount();
    public static harvestCallTimes = () => harvestCallTimes();

    // NOTE: We use callbacks we don't run into issues with cyclic dependencies
    //  (ex, using a hook in a controller where the hook also calls the controller).
    /*
        export const DiskLoggerController = SocketFunction.register(
            // Can be anything, but should be unique amongst other controllers on your server.
            "DiskLoggerController-f76a6fdf-3bd5-4bd4-a183-55a8be0a5a32",
            // Contains the functions that can be exposed, which must all be async.
            //  Only those listed below will be exposed.
            new DiskLoggerControllerBase(),
            () => ({
                // Only functions listed here will be exposed
                getRemoteLogFiles: {},
                getRemoteLogBuffer: {
                    compress: true,
                    // SocketFunctionClientHook[]
                    clientHooks: [
                        (x) => {
                            // If overrideResult is set, it skips the call and returns overrideResult
                            x.overrideResult = Buffer.from(...);
                        }
                    ]
                },
            }),
            () => ({
                // Default hooks for all functions
                // SocketFunctionHook[]
                hooks: [assertIsManagementUser],
            }),
            {
                // Additionaly flags
            }
        );
    */
    public static register<
        ClassInstance extends object,
        Shape extends SocketExposedShape<{
            [key in keyof ClassInstance]: (...args: any[]) => Promise<unknown>;
        }>,
        Statics
    >(
        classGuid: string,
        instance: ClassInstance | (() => ClassInstance),
        shapeFnc: () => Shape,
        defaultHooksFnc?: () => SocketExposedShape[""] & {
            onMount?: () => MaybePromise<void>;
        },
        config?: {
            /** @noAutoExpose If true SocketFunction.expose(Controller) must be called explicitly. */
            noAutoExpose?: boolean;
            statics?: Statics;
            /** Skip timing functions calls. Useful if a lot of functions have wait time that
                    is unrelated to processing, and therefore their timings won't be useful.
                    - Also useful if our auto function wrapping code is breaking functionality,
                        such as if you have a singleton function which you compare with ===,
                        which will breaks because we replaced it with a wrapped measure function.
            */
            noFunctionMeasure?: boolean;
        }
    ): SocketRegistered<ExtractShape<ClassInstance, Shape>> & Statics {
        let instanceFnc = lazy(typeof instance === "function" ? instance : () => instance);
        void Promise.resolve().then(() => {
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

        let getDefaultHooks = defaultHooksFnc && lazy(defaultHooksFnc);
        const getShape = lazy(() => {
            let shape = shapeFnc() as SocketExposedShape;
            let defaultHooks = getDefaultHooks?.();

            for (let value of Object.values(shape)) {
                if (!value) continue;
                value.noClientHooks = value.noClientHooks ?? defaultHooks?.noClientHooks;
                value.noDefaultHooks = value.noDefaultHooks ?? defaultHooks?.noDefaultHooks;
                if (!value.noClientHooks) {
                    value.clientHooks = [...(defaultHooks?.clientHooks || []), ...(value.clientHooks || [])];
                }
                if (value.noDefaultHooks) {
                    value.hooks = [...(value.hooks || [])];
                } else {
                    value.hooks = [...(defaultHooks?.hooks || []), ...(value.hooks || [])];
                }
                value.dataImmutable = defaultHooks?.dataImmutable ?? value.dataImmutable;
            }
            return shape as any as SocketExposedShape;
        });

        // Wait, so any constants referenced by the base shapeFnc will be fully resolved
        //  by now. This is IMPORTANT, as it allows permissions functions to be moved
        //  to a common module, instead of all being inline.
        void Promise.resolve().then(() => {
            registerClass(classGuid, instanceFnc() as SocketExposedInterface, getShape(), {
                noFunctionMeasure: config?.noFunctionMeasure,
            });
        });

        let socketCaller = SocketFunction.rehydrateSocketCaller({
            _classGuid: classGuid,
            _internalType: null as any,
        }, getShape);

        if (!config?.noAutoExpose) {
            this.expose(socketCaller);
        }
        return Object.assign(socketCaller, config?.statics) as any;
    }

    // Shared across copies of this package, so a given classGuid resolves to one canonical caller
    //  regardless of which copy rehydrated it. See createSingleton.
    private static socketCache = createSingleton("SocketFunction.socketCache", 1, () => new Map<string, SocketRegistered>()).get();
    public static rehydrateSocketCaller<Controller>(
        socketRegistered: SocketRegisterType<Controller>,
        // Shape is required for client hooks.
        shapeFnc?: () => SocketExposedShape,
    ): SocketRegistered<Controller> {
        let cached = this.socketCache.get(socketRegistered._classGuid);
        if (!cached) {
            let getShape = lazy(() => shapeFnc?.());
            let classGuid = socketRegistered._classGuid;
            let nodeProxy = getCallProxy(classGuid, async (call) => {
                return await SocketFunction.callFromGuid(call, classGuid, getShape());
            });

            cached = {
                nodes: nodeProxy,
                _classGuid: classGuid,
                _internalType: null as any,
            };

            this.socketCache.set(classGuid, cached);
        }
        return cached;
    }

    private static async callFromGuid<FncT extends FncType>(
        call: FullCallType<FncT>,
        classGuid: string,
        shape?: SocketExposedShape,
    ): Promise<ReturnType<FncType>> {
        let nodeId = call.nodeId;
        let functionName = call.functionName;
        let time = Date.now();
        if (SocketFunction.logMessages) {
            console.log(`START\t\t\t${classGuid}.${functionName} at ${Date.now()}`);
        }
        try {
            let callFactory = await getCreateCallFactory(nodeId);

            let shapeObj = shape?.[functionName];
            if (!shapeObj) {
                shapeObj = {};
            }
            // NOTE: Actually... this just means the client doesn't have a definition for it. The server
            //  might, so call it, and let them throw if it is unrecognized.
            // if (!shapeObj) {
            //     throw new Error(`Function ${functionName} is not in shape`);
            // }

            let hookResult = await runClientHooks(call, shapeObj as Exclude<SocketExposedShape[""], undefined>, callFactory.connectionId);

            if ("overrideResult" in hookResult) {
                for (let callback of hookResult.onResult) {
                    await callback(hookResult.overrideResult);
                }
                if ("overrideResult" in hookResult) {
                    return hookResult.overrideResult;
                }
            }

            let result = await callFactory.performCall(call);
            for (let callback of hookResult.onResult) {
                await callback(result);
            }
            if ("overrideResult" in hookResult) {
                return hookResult.overrideResult;
            }
            return result;
        } finally {
            time = Date.now() - time;
            if (SocketFunction.logMessages) {
                console.log(`FINISHED\t${time}ms\t${classGuid}.${functionName} at ${Date.now()}`);
            }
        }
    }

    /** Will dedupe callbacks, so if you call with the same callback it won't call it multiple times (otherwise it's difficult to manage this, as this only calls on the NEXT callback).
        IMPORTANT! Client node ids will NEVER reconnect, so this can full cleanup. However full nodeIds might if we try to use that nodeId again, so this cannot fully clean them up.
    */
    public static onNextDisconnect(
        nodeId: string,
        callback: () => void,
        // NOTE: It's important to know that unlike client ids, server ids (a nodeId YOU connect to, instead of connecting to you), might be alive again, and so you need some kind of logic to try it again or in some way reconnect. For clients you don't need to, as it's their job to reconnect to you, and they will reconnect with a NEW nodeId.
        noServerNodeIdWarning?: "iKnowThatServerNodeIdsMayReconnect_andIHandleReconnections"
    ) {
        if (!isClientNodeId(nodeId) && !noServerNodeIdWarning) {
            console.error(`Watching for disconnections of ${nodeId}. This is a server nodeId and may be alive again after disconnection. Please set the noServerNodeIdWarning flag in this argument to confirm you are handling reconnecting if the server becomes available again.`);
        }
        (async () => {
            let factory = await getCallFactory(nodeId);
            if (!factory) {
                for (let i = 0; i < 30; i++) {
                    await delay(1000);
                    factory = await getCallFactory(nodeId);
                    if (factory) break;
                }
                if (!factory) {
                    console.error(`Failed to get call factory for ${nodeId} after 30 seconds, giving up.`);
                    callback();
                    return;
                }
            }

            factory.onNextDisconnect(callback);
        })().catch(() => {
            callback();
        });
    }
    public static getLastDisconnectTime(nodeId: string): number | undefined {
        let factory = getCallFactory(nodeId);
        if (!factory) {
            return undefined;
        }
        if (factory instanceof Promise) {
            return undefined;
        }
        return factory.lastClosed;
    }
    public static isNodeConnected(nodeId: string): boolean {
        let factory = getCallFactory(nodeId);
        if (!factory) {
            return false;
        }
        if (factory instanceof Promise) {
            return false;
        }
        return !!factory.isConnected;
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

    // Shared across copies of this package, so suppressing expose calls in one copy also suppresses
    //  them in the others. See createSingleton.
    private static ignoreExposeCount = createSingleton("SocketFunction.ignoreExposeCount", 1, () => ({ count: 0 }));
    public static async ignoreExposeCalls<T>(code: () => Promise<T>) {
        SocketFunction.ignoreExposeCount.get().count++;
        try {
            return await code();
        } finally {
            SocketFunction.ignoreExposeCount.get().count--;
        }
    }

    /** Expose should be called before your mounting occurs. It mostly just exists to ensure you include the class type,
     *      so the class type's module construction runs, which should trigger register. Otherwise you would have
     *      to add additional imports to ensure the register call runs.
     */
    public static expose(socketRegistered: SocketRegistered) {
        if (SocketFunction.ignoreExposeCount.get().count > 0) return;
        if (!socketRegistered._classGuid) {
            throw new Error("SocketFunction.expose must be called with a classGuid");
        }
        console.log(`Exposing Controller ${blue(socketRegistered._classGuid)}`);
        exposeClass(socketRegistered);
        this.exposedClasses.add(socketRegistered._classGuid);

        if (SocketFunction.mountState.get().hasMounted) {
            let mountCallbacks = SocketFunction.onMountCallbacks.get(socketRegistered._classGuid);
            for (let onMount of mountCallbacks || []) {
                Promise.resolve(onMount()).catch(e => {
                    console.error("Error in onMount callback exposed after mount", e);
                });
            }
        }
    }

    // All mount state is shared across copies of this package, so a second mount (even from a
    //  different copy) is rejected, and onMount/mountPromise observers fire once across them all.
    //  See createSingleton.
    private static mountState = createSingleton("SocketFunction.mountState", 1, () => {
        let mountResolve!: () => void;
        let mountPromise = new Promise<void>(resolve => mountResolve = resolve);
        return {
            hasMounted: false,
            mountedNodeId: "",
            mountedIP: "",
            mountResolve,
            mountPromise,
        };
    });
    public static get mountedNodeId() { return SocketFunction.mountState.get().mountedNodeId; }
    public static set mountedNodeId(value: string) { SocketFunction.mountState.get().mountedNodeId = value; }
    public static isMounted() { return !!this.mountedNodeId; }
    public static get mountedIP() { return SocketFunction.mountState.get().mountedIP; }
    public static set mountedIP(value: string) { SocketFunction.mountState.get().mountedIP = value; }
    public static get mountPromise() { return SocketFunction.mountState.get().mountPromise; }
    public static async mount(config: SocketServerConfig) {
        if (this.mountedNodeId) {
            throw new Error("SocketFunction already mounted, mounting twice in one thread is not allowed.");
        }

        this.mountedIP = config.public ? "0.0.0.0" : "127.0.0.1";
        if (config.ip) {
            this.mountedIP = config.ip;
        }

        const { waitForFirstTimeSync, shimDateNow } = await import("./time/trueTimeShim");
        shimDateNow();
        await waitForFirstTimeSync();

        // Wait for any additionals functions to expose themselves
        await delay("immediate");

        this.mountedNodeId = await startSocketServer(config);
        SocketFunction.mountState.get().hasMounted = true;
        for (let classGuid of SocketFunction.exposedClasses) {
            let callbacks = SocketFunction.onMountCallbacks.get(classGuid);
            if (!callbacks) continue;
            for (let callback of callbacks) {
                await callback();
            }
        }
        SocketFunction.mountState.get().mountResolve();
        return this.mountedNodeId;
    }

    /** Sets the default call when an http request is made, but no classGuid is set.
     *      NOTE: All other calls should be endpoint calls, even if those endpoints return a static file with an HTML content type.
     *          - However, to load new content, you should probably just use `require("./example.ts")`, which works on any files
     *              clientside that have also been required serverside (and whitelisted with module.allowclient = true,
     *              or with an `allowclient.flag` file in the directory or parent directory).
    */
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

    public static browserNodeId() {
        if (isNode()) {
            throw new Error("Cannot get browser nodeId on server");
        }
        let edgeNode = getBootedEdgeNode();
        if (edgeNode) {
            return edgeNode.host;
        }
        return SocketFunction.connect({ address: location.hostname, port: +location.port || 443 });
    }
    public static getBrowserNodeId() {
        return this.browserNodeId();
    }

    public static addGlobalHook(hook: SocketFunctionHook) {
        registerGlobalHook(hook as SocketFunctionHook);
    }
    public static addGlobalClientHook(hook: SocketFunctionClientHook) {
        registerGlobalClientHook(hook as SocketFunctionClientHook);
    }
}

defineSingletonConfig(SocketFunction, "SocketFunction.config", 1, [
    "logMessages",
    "trackMessageSizes",
    "MAX_MESSAGE_SIZE",
    "HTTP_ETAG_CACHE",
    "silent",
    "HTTP_COMPRESS",
    "COEP",
    "COOP",
    "TOTAL_CALLS",
    "ENABLE_CLIENT_MODE",
    "WIRE_SERIALIZER",
    "GET_ALTERNATE_NODE_IDS",
    "WIRE_WARN_TIME",
    "DISABLE_COMPRESSION",
]);

declare global {
    var BOOTED_EDGE_NODE: { host: string } | undefined;
}

function getBootedEdgeNode() {
    return BOOTED_EDGE_NODE as { host: string } | undefined;
}


export function _setSocketContext<T>(
    caller: CallerContext,
    code: () => T,
) {
    let ctx = socketContext.get();
    ctx.seqNum++;
    let seqNum = ctx.seqNum;
    ctx.caller = caller;
    try {
        return code();
    } finally {
        if (seqNum === ctx.seqNum) {
            ctx.caller = undefined;
        }
    }
}