export const socket = Symbol("socket");

export type SocketExposedInterface = {
    [functionName: string]: (...args: any[]) => Promise<unknown>;
};
export type SocketExposedInterfaceClass = {
    //new(): SocketExposedInterface;
    new(): unknown;
    prototype: unknown;
};
export interface SocketExposedShape<ExposedType extends SocketExposedInterface = SocketExposedInterface, CallContext extends CallContextType = CallContextType> {
    [functionName: string]: {
        hooks?: SocketFunctionHook<ExposedType, CallContext>[];
        clientHooks?: SocketFunctionClientHook<ExposedType, CallContext>[];
    };
}

export interface CallType {
    classGuid: string;
    functionName: string;
    args: unknown[];
    // NOTE: When making calls this needs to be set in the client hook.
    //  To set a timeout on returns, you can set it in the server hook.
    reconnectTimeout?: number;
}

export interface SocketFunctionHook<ExposedType extends SocketExposedInterface = SocketExposedInterface, CallContext extends CallContextType = CallContextType> {
    (config: HookContext<ExposedType, CallContext>): Promise<void>;
}
export type HookContext<ExposedType extends SocketExposedInterface = SocketExposedInterface, CallContext extends CallContextType = CallContextType> = {
    call: CallType;
    context: SocketRegistered["context"];
    // If the result is overriden, we continue evaluating hooks and perform the final call
    overrideResult?: unknown;
};

export type ClientHookContext<ExposedType extends SocketExposedInterface = SocketExposedInterface, CallContext extends CallContextType = CallContextType> = {
    call: CallType;
    // If the result is overriden, we continue evaluating hooks and perform the final call
    overrideResult?: unknown;
};
export interface SocketFunctionClientHook<ExposedType extends SocketExposedInterface = SocketExposedInterface, CallContext extends CallContextType = CallContextType> {
    (config: ClientHookContext<ExposedType, CallContext>): Promise<void>;
}

export type CallContextType = {
    [key: string]: unknown;
};

export interface SocketRegistered<ExposedType extends SocketExposedInterface = SocketExposedInterface, DynamicCallContext extends CallContextType = CallContextType> {
    nodes: {
        // NOTE: Don't pass around nodeId to other nodes, instead pass around NetworkLocation (which they
        //  then turn into a nodeId, which they can then check permissions on themself).
        [nodeId: string]: ExposedType;
    };
    context: {
        // If undefined we are not synchronously in a call
        curContext: DynamicCallContext | undefined;
        caller: CallerContext | undefined;
    };
    _classGuid: string;
}
export type CallerContext = {
    // IMPORTANT! Do not pass nodeId to other nodes with the intention of having
    //  them call functions directly using nodeId. Instead pass location, and have them use connect.
    //  - nodeId SHOULD be used to identify users though, as it cannot be impersonated
    nodeId: string;
    fromPort: number;
    location: NetworkLocation;
    // The location of the server. It helps if it is told, due to the fact that one server
    //  can serve multiple domains.
    serverLocation: NetworkLocation;
};

// IMPORTANT! Nodes at the same network location may vary, so you cannot store NetworkLocation
//  in a list of allowed users, otherwise they can be impersonated!
export interface NetworkLocation {
    address: string;
    listeningPorts: number[];
}