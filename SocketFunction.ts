/// <reference path="./require/RequireController.ts" />

import { SocketExposedInterface, SocketFunctionHook, SocketFunctionClientHook, SocketExposedShape, SocketRegistered, CallerContext, FullCallType, CallType, FncType, SocketRegisterType } from "./SocketFunctionTypes";
import { exposeClass, registerClass, registerGlobalClientHook, registerGlobalHook, runClientHooks } from "./src/callManager";
import { SocketServerConfig, startSocketServer } from "./src/webSocketServer";
import { getCallFactory, getCreateCallFactory, getNodeId, getNodeIdLocation } from "./src/nodeCache";
import { getCallProxy } from "./src/nodeProxy";
import { Args, MaybePromise } from "./src/types";
import { setDefaultHTTPCall } from "./src/callHTTPHandler";
import debugbreak from "debugbreak";
import { lazy } from "./src/caching";
import { delay } from "./src/batching";
import { blue, magenta } from "./src/formatting/logColors";
import { JSONLACKS } from "./src/JSONLACKS/JSONLACKS";
import "./SetProcessVariables";
import cborx from "cbor-x";
import { setFlag } from "./require/compileFlags";
import { isNode } from "./src/misc";
import { getPendingCallCount, harvestCallTimes, harvestFailedCallCount } from "./src/CallFactory";

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
    public static logMessages = false;
    public static trackMessageSizes = {
        upload: [] as ((size: number) => void)[],
        download: [] as ((size: number) => void)[],
        callTimes: [] as ((obj: { start: number; end: number; }) => void)[],
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

    // In retrospect... dynamically changing the wire serializer is a BAD idea. If any calls happen
    //  before it is changed, things just break. Also, it needs to be changed on both sides,
    //  or else things break. Also, it is very hard to detect when the issue is different serializers
    public static readonly WIRE_SERIALIZER = {
        serialize: (obj: unknown): MaybePromise<Buffer[]> => [cborxInstance.encode(obj)],
        deserialize: (buffers: Buffer[]): MaybePromise<unknown> => cborxInstance.decode(buffers[0]),
    };

    public static WIRE_WARN_TIME = 100;

    private static onMountCallbacks = new Map<string, (() => MaybePromise<void>)[]>();
    public static exposedClasses = new Set<string>();

    public static callerContext: CallerContext | undefined;
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

    private static socketCache = new Map<string, SocketRegistered>();
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

    public static onNextDisconnect(nodeId: string, callback: () => void) {
        (async () => {
            let factory = await getCallFactory(nodeId);
            if (!factory) {
                callback();
                return;
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

    private static ignoreExposeCount = 0;
    public static async ignoreExposeCalls<T>(code: () => Promise<T>) {
        this.ignoreExposeCount++;
        try {
            return await code();
        } finally {
            this.ignoreExposeCount--;
        }
    }

    /** Expose should be called before your mounting occurs. It mostly just exists to ensure you include the class type,
     *      so the class type's module construction runs, which should trigger register. Otherwise you would have
     *      to add additional imports to ensure the register call runs.
     */
    public static expose(socketRegistered: SocketRegistered) {
        if (this.ignoreExposeCount > 0) return;
        if (!socketRegistered._classGuid) {
            throw new Error("SocketFunction.expose must be called with a classGuid");
        }
        console.log(`Exposing Controller ${blue(socketRegistered._classGuid)}`);
        exposeClass(socketRegistered);
        this.exposedClasses.add(socketRegistered._classGuid);

        if (this.hasMounted) {
            let mountCallbacks = SocketFunction.onMountCallbacks.get(socketRegistered._classGuid);
            for (let onMount of mountCallbacks || []) {
                Promise.resolve(onMount()).catch(e => {
                    console.error("Error in onMount callback exposed after mount", e);
                });
            }
        }
    }

    public static mountedNodeId: string = "";
    public static isMounted() { return !!this.mountedNodeId; }
    public static mountedIP: string = "";
    private static hasMounted = false;
    private static onMountCallback: () => void = () => { };
    public static mountPromise: Promise<void> = new Promise(r => this.onMountCallback = r);
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
        this.hasMounted = true;
        for (let classGuid of SocketFunction.exposedClasses) {
            let callbacks = SocketFunction.onMountCallbacks.get(classGuid);
            if (!callbacks) continue;
            for (let callback of callbacks) {
                await callback();
            }
        }
        this.onMountCallback();
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

declare global {
    var BOOTED_EDGE_NODE: { host: string } | undefined;
}

function getBootedEdgeNode() {
    return BOOTED_EDGE_NODE as { host: string } | undefined;
}


let socketContextSeqNum = 1;

export function _setSocketContext<T>(
    caller: CallerContext,
    code: () => T,
) {
    socketContextSeqNum++;
    let seqNum = socketContextSeqNum;
    SocketFunction.callerContext = caller;
    try {
        return code();
    } finally {
        if (seqNum === socketContextSeqNum) {
            SocketFunction.callerContext = undefined;
        }
    }
}