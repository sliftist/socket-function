/// <reference path="./require/RequireController.ts" />

import { SocketExposedInterface, SocketFunctionHook, SocketFunctionClientHook, SocketExposedShape, SocketRegistered, CallerContext, FullCallType, CallType } from "./SocketFunctionTypes";
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
import { shimDateNow, waitForFirstTimeSync } from "./time/trueTimeShim";
import { isNode } from "./src/misc";

/** Always shim Date.now(), because we usually DO want an accurate time... */
shimDateNow();

setFlag(require, "cbor-x", "allowclient", true);
let cborxInstance = new cborx.Encoder({ structuredClone: true });

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

export class SocketFunction {
    public static logMessages = false;
    public static trackMessageSizes = {
        upload: [] as ((size: number) => void)[],
        download: [] as ((size: number) => void)[],
    };

    public static MAX_MESSAGE_SIZE = 1024 * 1024 * 32;

    public static HTTP_ETAG_CACHE = false;
    public static silent = true;

    public static HTTP_COMPRESS = false;

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

    // NOTE: We use callbacks we don't run into issues with cyclic dependencies
    //  (ex, using a hook in a controller where the hook also calls the controller).
    public static register<
        ClassInstance extends object,
        Shape extends SocketExposedShape<{
            [key in keyof ClassInstance]: (...args: any[]) => Promise<unknown>;
        }>,
        Statics
    >(
        classGuid: string,
        instance: ClassInstance,
        shapeFnc: () => Shape,
        defaultHooksFnc?: () => SocketExposedShape[""] & {
            onMount?: () => MaybePromise<void>;
        },
        config?: {
            /** @noAutoExpose If true SocketFunction.expose(Controller) must be called explicitly. */
            noAutoExpose?: boolean;
            statics?: Statics;
        }
    ): SocketRegistered<ExtractShape<ClassInstance, Shape>> & Statics {
        let getDefaultHooks = defaultHooksFnc && lazy(defaultHooksFnc);
        const getShape = lazy(() => {
            let shape = shapeFnc() as SocketExposedShape;
            let defaultHooks = getDefaultHooks?.();

            for (let value of Object.values(shape)) {
                if (!value) continue;
                value.clientHooks = [...(defaultHooks?.clientHooks || []), ...(value.clientHooks || [])];
                value.hooks = [...(defaultHooks?.hooks || []), ...(value.hooks || [])];
                value.dataImmutable = defaultHooks?.dataImmutable ?? value.dataImmutable;
            }
            return shape as any as SocketExposedShape;
        });

        void Promise.resolve().then(() => {
            registerClass(classGuid, instance as SocketExposedInterface, getShape());
        });

        let nodeProxy = getCallProxy(classGuid, async (call) => {
            let nodeId = call.nodeId;
            let functionName = call.functionName;
            let time = Date.now();
            if (SocketFunction.logMessages) {
                console.log(`START\t\t\t${classGuid}.${functionName} at ${Date.now()}`);
            }
            try {
                let callFactory = await getCreateCallFactory(nodeId);

                let shapeObj = getShape()[functionName];
                if (!shapeObj) {
                    throw new Error(`Function ${functionName} is not in shape`);
                }

                let hookResult = await runClientHooks(call, shapeObj as Exclude<SocketExposedShape[""], undefined>, callFactory.connectionId);

                if ("overrideResult" in hookResult) {
                    return hookResult.overrideResult;
                }

                return await callFactory.performCall(call);
            } finally {
                time = Date.now() - time;
                if (SocketFunction.logMessages) {
                    console.log(`FINISHED\t${time}ms\t${classGuid}.${functionName} at ${Date.now()}`);
                }
            }
        });

        let output: SocketRegistered = {
            nodes: nodeProxy,
            _classGuid: classGuid,
        };

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

        let result = output as any as SocketRegistered;
        if (!config?.noAutoExpose) {
            this.expose(result);
        }
        return Object.assign(result, config?.statics);
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

    /** Expose should be called before your mounting occurs. It mostly just exists to ensure you include the class type,
     *      so the class type's module construction runs, which should trigger register. Otherwise you would have
     *      to add additional imports to ensure the register call runs.
     */
    public static expose(socketRegistered: SocketRegistered) {
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
        if (!isNode()) {
            throw new Error("Cannot get browser nodeId on server");
        }
        return SocketFunction.connect({ address: location.hostname, port: +location.port || 443 });
    }

    public static addGlobalHook(hook: SocketFunctionHook<SocketExposedInterface>) {
        registerGlobalHook(hook as SocketFunctionHook);
    }
    public static addGlobalClientHook(hook: SocketFunctionClientHook<SocketExposedInterface>) {
        registerGlobalClientHook(hook as SocketFunctionClientHook);
    }
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