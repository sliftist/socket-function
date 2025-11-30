/// <reference types="node" />
/// <reference types="node" />
/// <reference types="node" />
import https from "https";
import { Watchable } from "./misc";
export type SocketServerConfig = (https.ServerOptions & {
    key: string | Buffer;
    cert: string | Buffer;
    port: number;
    /** You can also set `port: 0` if you don't care what port you want at all.  */
    useAvailablePortIfPortInUse?: boolean;
    public?: boolean;
    /** Tries forwarding ports (using UPnP), if we detect they aren't externally reachable.
     *      - This causes an extra request and delay during startup, so should only be used
     *          during development.
     *      - Ignored if public is false (in which case we mount on 127.0.0.1, so port forwarding
     *          wouldn't matter anyways).
    */
    autoForwardPort?: boolean;
    ip?: string;
    allowHostnames?: string[];
    allowHostnameFnc?: (hostname: string) => boolean;
    /** If the SNI matches this domain, we use a different key/cert.
     *      We remove subdomains until we find a match
     */
    SNICerts?: {
        [domain: string]: Watchable<https.ServerOptions>;
    };
});
export declare function startSocketServer(config: SocketServerConfig): Promise<string>;
