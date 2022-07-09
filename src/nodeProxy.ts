import { lazy } from "./caching";
import { SocketExposedInterface } from "../SocketFunctionTypes";

type CallProxyType = {
    [controllerName: string]: SocketExposedInterface;
};

let proxyCache = new Map<string, CallProxyType>();
export function getCallProxy(id: string, callback: (controllerName: string, functionName: string, args: unknown[]) => Promise<unknown>): CallProxyType {
    let value = proxyCache.get(id);
    if (!value) {
        let controllerCache = new Map<string, CallProxyType[""]>();
        value = new Proxy(Object.create(null), {
            get(target, controllerName) {
                if (typeof controllerName !== "string") return undefined;
                let controller = controllerCache.get(controllerName);
                if (!controller) {
                    controller = new Proxy(Object.create(null), {
                        get(target, functionName) {
                            if (typeof functionName !== "string") return undefined;
                            return (...args: unknown[]) => callback(controllerName, functionName, args);
                        }
                    }) as CallProxyType[""];
                    controllerCache.set(controllerName, controller);
                }
                return controller;
            },
        }) as CallProxyType;
        proxyCache.set(id, value);
    }
    return value;
}