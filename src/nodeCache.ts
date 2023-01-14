import { CallFactory, createCallFactory } from "./CallFactory";
import { MaybePromise } from "./types";
import { lazy } from "./caching";
import { SocketFunction } from "../SocketFunction";

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

/** A nodeId not available for reconnecting. */
export function getClientNodeId(address: string): string {
    return `client_${address}:${Date.now()}:${Math.random()}`;
}

export function getNodeIdLocation(nodeId: string): { address: string, port: number; } | undefined {
    if (nodeId.startsWith("client_")) {
        return undefined;
    }
    let [address, port] = nodeId.split(":");
    return { address, port: parseInt(port) };
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

export function getCreateCallFactoryLocation(nodeId: string, mountedNodeId: string): MaybePromise<CallFactory> {
    let callFactory = nodeCache.get(nodeId);
    if (callFactory === undefined) {
        callFactory = createCallFactory(undefined, nodeId, mountedNodeId);
        nodeCache.set(nodeId, callFactory);
    }
    return callFactory;
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