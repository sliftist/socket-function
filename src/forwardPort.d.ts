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
export declare function forwardPort(config: {
    externalPort: number;
    internalPort: number;
    duration?: number;
}): Promise<void>;
/** Our machine's LAN IP, as the router sees it — used to tell whether an existing port
 *      mapping points at us or at a different machine on the network. */
export declare function getLocalInternalIP(): Promise<string | undefined>;
/** True when our outbound address is private/CGNAT — i.e. a NAT sits between us and the
 *      internet, so forwarding a port is worthwhile. A public outbound address means we're
 *      directly reachable and forwarding is unnecessary. This is the cross-platform gate that
 *      replaced the old "skip forwarding on linux" check, so Linux hosts behind NAT forward. */
export declare function isBehindNAT(): Promise<boolean>;
