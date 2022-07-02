import { callFactoryFromLocation, CallFactory } from "./CallInstance";
import { NetworkLocation } from "./SocketFunctionTypes";
import { MaybePromise } from "./types";

// TODO: Add CallInstanceFactory.isClosed, so nodeCache can clean up old entries.
//  This is only needed for memory management, and not for correctness. Entries never
//  need to be refreshed, because NetworkLocation.listeningPorts shouldn't really change.
//  Either we will have listeningPorts and re-establish the connection, or we won't, and
//  then it is a client, in which case we cannot re-establish the connection (and we just
//  have to wait for the client to re-establish it). AND, if the listeningPorts change from
//  a value to a new value... then they should be obtained using connect() anyway,
//  and so whatever way the user got the NetworkLocation to begin with, they should use again.


// nodeId => 
const nodeCache = new Map<string, {
    callFactory: CallFactory;
}>();
const locationLookup = new Map<string, MaybePromise<string>>();

function getNetworkLocationHash(location: NetworkLocation): string {
    return location.address + ":" + location.localPort + "=" + location.listeningPorts.join("|");
}

// NOTE: For client connections, at which point we have the nodeId, location and callFactory.
export function registerNodeClient(callFactory: CallFactory) {
    let { nodeId } = callFactory;
    // NOTE: We can always clobber the entry, AS, during client connection we give NetworkLocation information,
    //  so even if we already have this node with NetworkLocation.listeningPorts, this new values should
    //  be even newer, or the same.
    //  - AND, clobbering shouldn't happen often, if the other end connected to us they should have given us their
    //      nodeId. So they'll use the existing websocket when using that nodeId, instead of establishing a new connection,
    //      except for race conditions cases, in which case we just have an extra connection, which isn't so bad...
    //      - And of course, we have to use the newer connection, as it might be the case that the NetworkLocation has actually
    //          updated, and the old connection is now forever closed.

    // Never go from listening ports to no listening ports. Worst case the listening ports are old
    //  and won't work, in which case... we won't be able to reconnect, which basically what
    //  we would do if there were no listening ports.
    let prevListeningPorts = nodeCache.get(nodeId)?.callFactory.location.listeningPorts;
    if (prevListeningPorts && !callFactory.location.listeningPorts.length) {
        callFactory.location.listeningPorts = prevListeningPorts;
    }
    // TODO: Maybe even preserve the address in some cases, such as if it was a domain, and is now an ip?
    nodeCache.set(nodeId, {
        callFactory,
    });
}

export function getCreateCallFactoryLocation(location: NetworkLocation): MaybePromise<string> {
    let locationHash = getNetworkLocationHash(location);
    let nodeId = locationLookup.get(locationHash);
    if (nodeId !== undefined) {
        return nodeId;
    }

    let callFactoryPromise = callFactoryFromLocation(location);
    let nodeIdPromise = callFactoryPromise.then(x => x.nodeId);
    locationLookup.set(locationHash, nodeIdPromise);

    return callFactoryPromise.then(callFactory => {
        let nodeId = callFactory.nodeId;
        // TODO: Maybe warn if we just clobbered a nodeId?
        let prevEntry = nodeCache.get(nodeId);
        if (prevEntry) {
            console.warn(`Clobbering nodeId ${nodeId}, with a new location ${locationHash}, was ${getNetworkLocationHash(prevEntry.callFactory.location)}. (This might indiciate multiple locations with the same nodeId, which could cause an issue. If this happens repeatedly it will cause stability issues).`);
        }
        nodeCache.set(nodeId, {
            callFactory,
        });
        return nodeId;
    });
}


// TODO: Give a special error if the nodeId has been seen, but is only one-way (from HTTP requests).
export function getCallFactoryNodeId(nodeId: string): CallFactory|undefined {
    return nodeCache.get(nodeId)?.callFactory;
}