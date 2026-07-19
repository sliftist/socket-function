/** Resolves the UPnP Internet Gateway Device we can talk to, along with the local
 *      addressing needed to build SOAP requests against it. Shared by every operation
 *      that needs to reach the router's control endpoint. */
export declare function resolveGateway(): Promise<{
    internalIP: string;
    gatewayIP: string;
    controlPort: number;
    controlURLs: string[];
}>;
export interface PortMapping {
    externalPort: number;
    internalPort: number;
    protocol: string;
    /** The LAN client the mapping forwards to (NewInternalClient). */
    internalClient: string;
    /** Empty string means "any" remote host (the usual case). */
    remoteHost: string;
    enabled: boolean;
    description: string;
    /** Remaining lease in seconds; 0 means a permanent (static) mapping. */
    leaseDuration: number;
}
/** Queries the router for every existing UPnP port mapping by walking
 *      GetGenericPortMappingEntry from index 0 until the gateway reports the index
 *      is out of range (SOAP error 713 / a non-200 response). */
export declare function listPortMappings(): Promise<PortMapping[]>;
/** Outcome of forwardPort. `owned` is true once we hold the router mapping for the port. When
 *      false, `reason` says why: "declined" = noPortStealing and another host holds the port (the
 *      caller should try a different port); "notBehindNat" = we have a public/directly-reachable
 *      address so there's nothing to forward; "error" = UPnP unreachable / create failed (best-effort,
 *      nothing forwarded but the caller can carry on). Only "declined" warrants trying another port. */
export type ForwardPortResult = {
    owned: boolean;
    reason?: "declined" | "notBehindNat" | "error";
};
export declare function forwardPort(config: {
    externalPort: number;
    internalPort: number;
    /** Lease length in ms. Defaults to a PERMANENT mapping (never expires), which is what you want:
     *      finite leases can't be refreshed gap-free (see PERMANENT_LEASE). Pass a finite duration
     *      only if you specifically want the mapping to expire on its own — in that case we do NOT
     *      run the supersession monitor, since a finite mapping is expected to disappear. */
    duration?: number;
    /** If the port is already forwarded to a DIFFERENT internal client, don't steal it: return
     *      { owned: false, reason: "declined" } instead of taking over. Off by default (default is
     *      last-writer-wins takeover). An existing mapping that is ours (or none) is still (re)claimed. */
    noPortStealing?: boolean;
}): Promise<ForwardPortResult>;
/** Our machine's LAN IP, as the router sees it — used to tell whether an existing port
 *      mapping points at us or at a different machine on the network. */
export declare function getLocalInternalIP(): Promise<string | undefined>;
/** True when our outbound address is private/CGNAT — i.e. a NAT sits between us and the
 *      internet, so forwarding a port is worthwhile. A public outbound address means we're
 *      directly reachable and forwarding is unnecessary. This is the cross-platform gate that
 *      replaced the old "skip forwarding on linux" check, so Linux hosts behind NAT forward. */
export declare function isBehindNAT(): Promise<boolean>;
export declare function createPortMapping(config: {
    externalPort: number;
    internalPort: number;
    gatewayIP: string;
    controlPort: number;
    controlPath: string;
    internalIP: string;
    duration: number;
}): Promise<void>;
export declare function deletePortMapping(config: {
    externalPort: number;
    gatewayIP: string;
    controlPort: number;
    controlPath: string;
}): Promise<void>;
