/// <reference path="require/RequireController.d.ts" />
/// <reference types="node" />
/// <reference types="node" />
import { SocketExposedInterface, SocketFunctionHook, SocketFunctionClientHook, SocketExposedShape, SocketRegistered, CallerContext, FullCallType, SocketRegisterType } from "./SocketFunctionTypes";
import { SocketServerConfig } from "./src/webSocketServer";
import { Args, MaybePromise } from "./src/types";
import "./SetProcessVariables";
type ExtractShape<ClassType, Shape> = {
    [key in keyof ClassType]: (key extends keyof Shape ? ClassType[key] extends SocketExposedInterface[""] ? ClassType[key] : ClassType[key] extends Function ? "All exposed function must be async (or return a Promise)" : never : "Function has implementation but is not exposed in the SocketFunction.register call");
};
export declare class SocketFunction {
    static logMessages: boolean;
    static trackMessageSizes: {
        upload: ((size: number) => void)[];
        download: ((size: number) => void)[];
        callTimes: ((obj: {
            start: number;
            end: number;
        }) => void)[];
    };
    static MAX_MESSAGE_SIZE: number;
    static HTTP_ETAG_CACHE: boolean;
    static silent: boolean;
    static HTTP_COMPRESS: boolean;
    static COEP: string;
    static COOP: string;
    static readonly WIRE_SERIALIZER: {
        serialize: (obj: unknown) => MaybePromise<Buffer[]>;
        deserialize: (buffers: Buffer[]) => MaybePromise<unknown>;
    };
    static WIRE_WARN_TIME: number;
    private static onMountCallbacks;
    static exposedClasses: Set<string>;
    static callerContext: CallerContext | undefined;
    static getCaller(): CallerContext;
    static harvestFailedCallCount: () => number;
    static getPendingCallCount: () => number;
    static harvestCallTimes: () => {
        start: number;
        end: number;
    }[];
    static register<ClassInstance extends object, Shape extends SocketExposedShape<{
        [key in keyof ClassInstance]: (...args: any[]) => Promise<unknown>;
    }>, Statics>(classGuid: string, instance: ClassInstance | (() => ClassInstance), shapeFnc: () => Shape, defaultHooksFnc?: () => SocketExposedShape[""] & {
        onMount?: () => MaybePromise<void>;
    }, config?: {
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
    }): SocketRegistered<ExtractShape<ClassInstance, Shape>> & Statics;
    private static socketCache;
    static rehydrateSocketCaller<Controller>(socketRegistered: SocketRegisterType<Controller>, shapeFnc?: () => SocketExposedShape): SocketRegistered<Controller>;
    private static callFromGuid;
    static onNextDisconnect(nodeId: string, callback: () => void): void;
    static getLastDisconnectTime(nodeId: string): number | undefined;
    static isNodeConnected(nodeId: string): boolean;
    /** NOTE: Only works if the nodeIs used is from SocketFunction.connect (we can't convert arbitrary nodeIds into urls,
     *      as we have no way of knowing how to contain a nodeId).
     *  */
    static getHTTPCallLink(call: FullCallType): string;
    private static ignoreExposeCount;
    static ignoreExposeCalls<T>(code: () => Promise<T>): Promise<T>;
    /** Expose should be called before your mounting occurs. It mostly just exists to ensure you include the class type,
     *      so the class type's module construction runs, which should trigger register. Otherwise you would have
     *      to add additional imports to ensure the register call runs.
     */
    static expose(socketRegistered: SocketRegistered): void;
    static mountedNodeId: string;
    static isMounted(): boolean;
    static mountedIP: string;
    private static hasMounted;
    private static onMountCallback;
    static mountPromise: Promise<void>;
    static mount(config: SocketServerConfig): Promise<string>;
    /** Sets the default call when an http request is made, but no classGuid is set.
     *      NOTE: All other calls should be endpoint calls, even if those endpoints return a static file with an HTML content type.
     *          - However, to load new content, you should probably just use `require("./example.ts")`, which works on any files
     *              clientside that have also been required serverside (and whitelisted with module.allowclient = true,
     *              or with an `allowclient.flag` file in the directory or parent directory).
    */
    static setDefaultHTTPCall<Registered extends SocketRegistered, FunctionName extends keyof Registered["nodes"][""] & string>(registered: Registered, functionName: FunctionName, ...args: Args<Registered["nodes"][""][FunctionName]>): void;
    static connect(location: {
        address: string;
        port: number;
    }): string;
    static browserNodeId(): string;
    static getBrowserNodeId(): string;
    static addGlobalHook(hook: SocketFunctionHook): void;
    static addGlobalClientHook(hook: SocketFunctionClientHook): void;
}
declare global {
    var BOOTED_EDGE_NODE: {
        host: string;
    } | undefined;
}
export declare function _setSocketContext<T>(caller: CallerContext, code: () => T): T;
export {};
