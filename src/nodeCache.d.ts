import { CallFactory } from "./CallFactory";
import { MaybePromise } from "./types";
export declare function getNodeId(domain: string, port: number): string;
/** @deprecated, call getBrowserUrlNode instead, which does important additional checks. */
export declare function getNodeIdFromLocation(): string;
/** A nodeId not available for reconnecting. */
export declare function getClientNodeId(address: string): string;
export declare function isClientNodeId(nodeId: string): boolean;
/** Will always be available, even if getNodeIdLocation is not (as we don't always have the port,
 *      but we should always have an address).
 *  - Rarely used, as for logging you can just log the nodeId. ALSO, it isn't sufficient to reconnect, as the port is also needed!
 *  */
export declare function getNodeIdIP(nodeId: string): string;
export declare function getNodeIdLocation(nodeId: string): {
    address: string;
    port: number;
} | undefined;
export declare function getNodeIdDomain(nodeId: string): string;
export declare function getNodeIdDomainMaybeUndefined(nodeId: string): string | undefined;
export declare function registerNodeClient(callFactory: CallFactory): void;
export declare function getCreateCallFactory(nodeId: string): MaybePromise<CallFactory>;
export declare function getCallFactory(nodeId: string): MaybePromise<CallFactory | undefined>;
export declare function resetAllNodeCallFactories(): void;
export declare function countOpenConnections(): number;
