import { CallFactory, createCallFactory } from "./CallFactory";
import { MaybePromise } from "./types";
import { lazy } from "./caching";
import { SocketFunction } from "../SocketFunction";
import { isNode } from "./misc";

// TODO: Add CallInstanceFactory.isClosed, so nodeCache can clean up old entries.
//  This is only needed for memory management, and not for correctness. Entries never
//  need to be refreshed, because NetworkLocation.listeningPorts shouldn't really change.
//  Either we will have listeningPorts and re-establish the connection, or we won't, and
//  then it is a client, in which case we cannot re-establish the connection (and we just
//  have to wait for the client to re-establish it). AND, if the listeningPorts change from
//  a value to a new value... then they should be obtained using connect() anyway,
//  and so whatever way the user got the NetworkLocation to begin with, they should use again.

export function getNodeId(domain: string, port: number): string {
    // NOTE: As domains are never reused, this doesn't need any randomness
    return `${domain}:${port}`;
}

export function getNodeIdFromLocation() {
    if (isNode()) throw new Error(`Cannot get nodeId from location, as we are running in NodeJS`);
    return getNodeId(location.hostname, location.port ? parseInt(location.port) : 443);
}

/** A nodeId not available for reconnecting. */
export function getClientNodeId(address: string): string {
    return `client:${address}:${Date.now()}:${Math.random()}`;
}
export function isClientNodeId(nodeId: string): boolean {
    return nodeId.startsWith("client:");
}
/** Will always be available, even if getNodeIdLocation is not (as we don't always have the port,
 *      but we should always have an address).
 *  - Rarely used, as for logging you can just log the nodeId. ALSO, it isn't sufficient to reconnect, as the port is also needed!
 *  */
export function getNodeIdIP(nodeId: string): string {
    if (isClientNodeId(nodeId)) {
        return nodeId.split(":")[1];
    }
    return getNodeIdLocation(nodeId)!.address;
}

export function getNodeIdLocation(nodeId: string): { address: string, port: number; } | undefined {
    if (isClientNodeId(nodeId)) {
        return undefined;
    }
    let [address, port] = nodeId.split(":");
    return { address, port: parseInt(port) };
}

export function getNodeIdDomain(nodeId: string): string {
    let result = getNodeIdDomainMaybeUndefined(nodeId);
    if (result === undefined) {
        throw new Error(`Cannot get domain from nodeId, which is only usable as a client. NodeId: ${JSON.stringify(nodeId)}`);
    }
    return result;
}
export function getNodeIdDomainMaybeUndefined(nodeId: string): string | undefined {
    let location = getNodeIdLocation(nodeId);
    if (!location) {
        return undefined;
    }
    return new URL(location.address).hostname.split(".").slice(-2).join(".");
}

// NOTE: CallFactory turns into an actual CallFactory when registerNodeClient is called
// nodeId => 
const nodeCache = new Map<string, MaybePromise<CallFactory>>();

// NOTE: Should be called directly inside call factory constructor whenever
//      their nodeId changes (and on construction).
export function registerNodeClient(callFactory: CallFactory) {
    nodeCache.set(callFactory.nodeId, callFactory);
    startCleanupLoop();
}

export function getCreateCallFactory(nodeId: string): MaybePromise<CallFactory> {
    let callFactory = nodeCache.get(nodeId);
    if (callFactory === undefined) {
        callFactory = createCallFactory(undefined, nodeId);
        nodeCache.set(nodeId, callFactory);
    }
    return callFactory;
}
export function getCallFactory(nodeId: string): MaybePromise<CallFactory | undefined> {
    return nodeCache.get(nodeId);
}

const startCleanupLoop = lazy(() => {
    (async () => {
        while (true) {
            for (let [key, value] of Array.from(nodeCache.entries())) {
                let factory = value;
                if (!(factory instanceof Promise)) {
                    if (factory.closedForever) {
                        nodeCache.delete(key);
                    }
                }
            }
            await new Promise(resolve => setTimeout(resolve, 1000 * 60 * 5));
        }
    })().catch(e => {
        console.error(`nodeCache cleanup loop failed, ${e.stack}`);
    });
});