import { SocketExposedInterface, CallContextType, SocketFunctionHook, SocketFunctionClientHook, SocketExposedShape, SocketRegistered, NetworkLocation, CallerContext, SocketExposedInterfaceClass, CallType } from "./SocketFunctionTypes";
import { exposeClass, registerClass, registerGlobalClientHook, registerGlobalHook, runClientHooks } from "./callManager";
import { SocketServerConfig, startSocketServer } from "./socketServer";
import { getCallFactoryNodeId, getCreateCallFactoryLocation } from "./nodeCache";
import { getCallProxy } from "./nodeProxy";


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
    public static register<
        ClassType extends SocketExposedInterfaceClass,
        Shape extends SocketExposedShape<SocketExposedInterface, CallContext>,
        CallContext extends CallContextType
    >(
        classGuid: string,
        classType: ClassType,
        shape: Shape
    ): (
            // Essentially just returns SocketRegistered
            ExtractShape<ClassType["prototype"], Shape> extends SocketExposedInterface
            ? SocketRegistered<ExtractShape<ClassType["prototype"], Shape>, CallContext>
            : {
                error: "invalid shape";
            } & PickByType<ExtractShape<ClassType["prototype"], Shape>, string>
        ) {
        registerClass(classGuid, classType, shape as any as SocketExposedShape);

        let nodeProxy = getCallProxy(classGuid, async (nodeId, functionName, args) => {
            let callFactory = getCallFactoryNodeId(nodeId);
            if (!callFactory) {
                throw new Error(`Cannot reach node ${nodeId}. Either it was established via an HTTP call, or was incorrect provided to us via another node, which should have provided us a NetworkLocation instead.`);
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
        });

        let output: SocketRegistered = {
            context: curSocketContext,
            nodes: nodeProxy,
        };

        return output as any;
    }

    /** Expose should be called before your mounting occurs. It mostly just exists to ensure you include the class type,
     *      so the class type's module construction runs, which should trigger register. Otherwise you would have
     *      to add additional imports to ensure the register call runs.
     */
    public static expose(classType: SocketExposedInterfaceClass) {
        exposeClass(classType);
    }

    public static async mount(config: SocketServerConfig) {
        await startSocketServer(config);
    }

    public static async connect(location: NetworkLocation | { address: string; port: number }): Promise<string> {
        if (!("localPort" in location)) {
            location = {
                address: location.address,
                listeningPorts: [location.port],
                localPort: 0,
            };
        }
        return await getCreateCallFactoryLocation(location);
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