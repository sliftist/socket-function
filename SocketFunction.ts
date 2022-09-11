import { SocketExposedInterface, CallContextType, SocketFunctionHook, SocketFunctionClientHook, SocketExposedShape, SocketRegistered, NetworkLocation, CallerContext, SocketExposedInterfaceClass, CallType } from "./SocketFunctionTypes";
import { exposeClass, registerClass, registerGlobalClientHook, registerGlobalHook, runClientHooks } from "./src/callManager";
import { SocketServerConfig, startSocketServer } from "./src/webSocketServer";
import { getCallFactoryNodeId, getCreateCallFactoryLocation, getNetworkLocationHash } from "./src/nodeCache";
import { getCallProxy } from "./src/nodeProxy";
import { Args } from "./src/types";
import { setDefaultHTTPCall } from "./src/callHTTPHandler";
import { isNode } from "./src/misc";
import { getOwnNodeId } from "./src/nodeAuthentication";

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
    public static rejectUnauthorized = true;
    public static additionalTrustedRootCAs: string[] = [];

    public static register<
        ClassInstance extends object,
        Shape extends SocketExposedShape<SocketExposedInterface, CallContext>,
        CallContext extends CallContextType
    >(
        classGuid: string,
        instance: ClassInstance,
        shape: Shape
    ):
        (
            // Essentially just returns SocketRegistered
            ExtractShape<ClassInstance, Shape> extends SocketExposedInterface
            ? SocketRegistered<ExtractShape<ClassInstance, Shape>, CallContext>
            : {
                error: "invalid shape";
            } & PickByType<ExtractShape<ClassInstance, Shape>, string>
        ) {

        registerClass(classGuid, instance as SocketExposedInterface, shape as any as SocketExposedShape);

        let nodeProxy = getCallProxy(classGuid, async (nodeId, functionName, args) => {
            let time = Date.now();
            if (SocketFunction.logMessages) {
                console.log(`START\t\t\t${classGuid}.${functionName}`);
            }
            try {
                let callFactory = await getCallFactoryNodeId(nodeId);
                if (!callFactory) {
                    throw new Error(`Cannot reach node ${nodeId}. It might have been incorrect provided to us via another node, which should have provided us a NetworkLocation instead.`);
                }

                let shapeObj = shape[functionName];
                if (!shapeObj) {
                    throw new Error(`Function ${functionName} is not in shape`);
                }

                let call: CallType = {
                    classGuid,
                    args,
                    functionName,
                };

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

        return output as any;
    }

    /** Expose should be called before your mounting occurs. It mostly just exists to ensure you include the class type,
     *      so the class type's module construction runs, which should trigger register. Otherwise you would have
     *      to add additional imports to ensure the register call runs.
     */
    public static expose(socketRegistered: SocketRegistered) {
        exposeClass(socketRegistered);
    }

    public static async mount(config: SocketServerConfig) {
        await startSocketServer(config);
    }

    public static async getOwnNodeId() {
        return await getOwnNodeId();
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

    public static async connect(location: NetworkLocation | { address: string; port: number }): Promise<string> {
        if (!("listeningPorts" in location)) {
            location = {
                address: location.address,
                listeningPorts: [location.port]
            };
        }
        return await getCreateCallFactoryLocation(location);
    }

    public static connectSync(location: NetworkLocation | { address: string; port: number }): string {
        if (!("listeningPorts" in location)) {
            location = {
                address: location.address,
                listeningPorts: [location.port]
            };
        }
        let tempNodeId = "syncTempNodeId_" + getNetworkLocationHash(location);

        void getCreateCallFactoryLocation(location, tempNodeId);

        return tempNodeId;
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