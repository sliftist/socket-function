/// <reference types="node" />
import * as net from "net";
interface DNSRecord {
    address: string;
    family: number;
}
export declare function resolveHost(hostname: string, family?: number): Promise<DNSRecord[]>;
export declare const dnsCacheLookup: net.LookupFunction;
export declare function reportConnectionFailure(hostname: string): Promise<boolean>;
export {};
