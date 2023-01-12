module.allowclient = true;

import debugbreak from "debugbreak";
import * as tls from "tls";
import { SenderInterface } from "./src/CallFactory";
import { isNode } from "./src/misc";
import { CertInfo, getNodeIdFromCert } from "./src/nodeAuthentication";
import { getCallObj } from "./src/nodeProxy";
import { Args, MaybePromise } from "./src/types";

export const socket = Symbol("socket");

export type SocketExposedInterface = {
    [functionName: string]: (...args: any[]) => Promise<unknown>;
};
export type SocketInternalInterface = {
    [functionName: string]: {
        [getCallObj]: (...args: any[]) => FullCallType;
        (...args: any[]): Promise<unknown>;
    }
}
export type SocketExposedInterfaceClass = {
    //new(): SocketExposedInterface;
    new(): unknown;
    prototype: unknown;
};
export interface SocketExposedShape<ExposedType extends SocketExposedInterface = SocketExposedInterface, CallContext extends CallContextType = CallContextType> {
    [functionName: string]: {
        /** Indicates with the same input, we give the same output, forever,
         *      independent of code changes. This only works for data storage.
         */
        dataImmutable?: boolean;
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
export interface FullCallType extends CallType {
    nodeId: string;
}

export interface SocketFunctionHook<ExposedType extends SocketExposedInterface = SocketExposedInterface, CallContext extends CallContextType = CallContextType> {
    (config: HookContext<ExposedType, CallContext>): MaybePromise<void>;
}
export type HookContext<ExposedType extends SocketExposedInterface = SocketExposedInterface, CallContext extends CallContextType = CallContextType> = {
    call: CallType;
    context: SocketRegistered["context"];
    // If the result is overriden, we continue evaluating hooks BUT NOT perform the final call
    overrideResult?: unknown;
};

export type ClientHookContext<ExposedType extends SocketExposedInterface = SocketExposedInterface, CallContext extends CallContextType = CallContextType> = {
    call: CallType;
    // If the result is overriden, we continue evaluating hooks BUT NOT perform the final call
    overrideResult?: unknown;
};
export interface SocketFunctionClientHook<ExposedType extends SocketExposedInterface = SocketExposedInterface, CallContext extends CallContextType = CallContextType> {
    (config: ClientHookContext<ExposedType, CallContext>): MaybePromise<void>;
}

export type CallContextType = {
    [key: string]: unknown;
};

export interface SocketRegistered<ExposedType = any, DynamicCallContext extends CallContextType = CallContextType> {
    nodes: {
        // NOTE: Don't pass around nodeId to other nodes, instead pass around NetworkLocation (which they
        //  then turn into a nodeId, which they can then check permissions on themself).
        [nodeId: string]: {
            [functionName in keyof ExposedType]: ExposedType[functionName] & {
                [getCallObj]: (...args: Args<ExposedType[functionName]>) => FullCallType;
            }
        };
    };
    context: {
        // If undefined we are not synchronously in a call
        curContext: DynamicCallContext | undefined;
        caller: CallerContext | undefined;
    };
    _classGuid: string;
}
export type CallerContext = Readonly<CallerContextBase>;
type CallerContextBase = {
    // IMPORTANT! Do not pass nodeId to other nodes with the intention of having
    //  them call functions directly using nodeId. Instead pass location, and have them use connect.
    //  - nodeId will be unique per thread, so is only useful for temporary communcation. If you want
    //      a more permanent identity, you must derive it from certInfo yourself.
    nodeId: string;
    /** Gives further info on the node. When we set this, we always make sure it has a verified
     *      issuer. It may be set by app code, which should make sure the issuer is verified (not
     *      necessarily by the machine, but just in some sense, 'verified', to secure the common name
     *      of the cert and prevent anyone from using the same common name as someone else).
     *  IF set, is directly used to derive nodeId (by nodeAuthentication.ts)
     */
    certInfo: CertInfo | undefined;
    updateCertInfo?: (certInfo: CertInfo | undefined) => void;

    fromPort: number;
    // The location of the client (for reconnects, tracking, etc)
    location: NetworkLocation;
    // The location of the server (US). It helps if it is told, due to the fact that one server
    //  can serve multiple domains, and so might not know how the client is connecting to it.
    serverLocation: NetworkLocation;
};

export function initCertInfo(
    contextIn: CallerContext,
    sender: { socket?: tls.TLSSocket; _socket?: tls.TLSSocket }
) {
    const context = contextIn as CallerContextBase;

    context.updateCertInfo = (certRaw: CertInfo | undefined) => {
        let nodeId = getNodeIdFromCert(certRaw);
        if (nodeId) {
            context.nodeId = nodeId;
            // If the peer cert doesn't give a nodeId, don't even set it, as it is likely
            //  just an empty object.
            context.certInfo = certRaw;
        } else {
            const location = context.location;
            // Just put a nodeId there so we can keep track of the connection
            context.nodeId = location.address + ":" + location.listeningPorts[0] + "_" + Date.now() + "_" + Math.random();
        }
    };

    let peerCert = (sender.socket || sender._socket)?.getPeerCertificate(true);
    context.updateCertInfo(peerCert);
}

// IMPORTANT! Nodes at the same network location may vary, so you cannot store NetworkLocation
//  in a list of allowed users, otherwise they can be impersonated!
export interface NetworkLocation {
    address: string;
    listeningPorts: number[];
}