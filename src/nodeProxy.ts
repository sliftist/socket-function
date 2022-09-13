import { lazy } from "./caching";
import { FullCallType, SocketExposedInterface, SocketInternalInterface } from "../SocketFunctionTypes";

type CallProxyType = {
    [nodeId: string]: SocketInternalInterface;
};

export const getCallObj = Symbol.for("getCallObj");

let proxyCache = new Map<string, CallProxyType>();
export function getCallProxy(id: string, callback: (callType: FullCallType) => Promise<unknown>): CallProxyType {
    let value = proxyCache.get(id);
    if (!value) {
        let nodeCache = new Map<string, CallProxyType[""]>();
        value = new Proxy(Object.create(null), {
            get(target, nodeId) {
                if (typeof nodeId !== "string") return undefined;
                let nodeProxy = nodeCache.get(nodeId);
                if (!nodeProxy) {
                    nodeProxy = new Proxy(Object.create(null), {
                        get(target, functionName) {
                            if (typeof functionName !== "string") return undefined;
                            return Object.assign(
                                (...args: unknown[]) => {
                                    let call: FullCallType = {
                                        classGuid: id,
                                        nodeId,
                                        functionName,
                                        args,
                                    };
                                    return callback(call);
                                },
                                {
                                    [getCallObj]: (...args: unknown[]) => {
                                        let call: FullCallType = {
                                            classGuid: id,
                                            nodeId,
                                            functionName,
                                            args,
                                        };
                                        return call;
                                    }
                                }
                            );
                        }
                    }) as CallProxyType[""];
                    nodeCache.set(nodeId, nodeProxy);
                }
                return nodeProxy;
            },
        }) as CallProxyType;
        proxyCache.set(id, value);
    }
    return value;
}