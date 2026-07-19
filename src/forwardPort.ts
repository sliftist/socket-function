import debugbreak from "debugbreak";
import * as dgram from "dgram";
import os from "os";
import { timeInMinute } from "./misc";

const SSDP_DISCOVER_MX = 2;
const SSDP_DISCOVER_MSG = `M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: ${SSDP_DISCOVER_MX}\r\nST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n\r\n`;

/** Resolves the UPnP Internet Gateway Device we can talk to, along with the local
 *      addressing needed to build SOAP requests against it. Shared by every operation
 *      that needs to reach the router's control endpoint. */
export async function resolveGateway(): Promise<{
    internalIP: string;
    gatewayIP: string;
    controlPort: number;
    controlURLs: string[];
}> {
    let internalIP = await getOutboundIP();
    if (!internalIP) throw new Error("Could not determine our local network address");

    // The gateway that answers SSDP discovery is the router we forward through; take its IP
    //  and control port straight from the discovered device URL rather than parsing routes.
    let gateway = await discoverGateway(internalIP);
    let gatewayURL = new URL(gateway);
    let gatewayIP = gatewayURL.hostname;
    let controlPort = Number(gatewayURL.port);
    let controlURLs = await getControlPaths(gateway);

    console.log(`Local IP: ${internalIP}, Gateway IP: ${gatewayIP}`);

    return { internalIP, gatewayIP, controlPort, controlURLs };
}

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
export async function listPortMappings(): Promise<PortMapping[]> {
    const { internalIP, gatewayIP, controlPort, controlURLs } = await resolveGateway();

    let lastError: unknown;
    for (let controlURL of controlURLs) {
        try {
            const mappings: PortMapping[] = [];
            for (let index = 0; ; index++) {
                const entry = await getGenericPortMappingEntry({
                    gatewayIP,
                    controlPort,
                    controlPath: controlURL,
                    index,
                });
                if (!entry) break;
                mappings.push(entry);
            }
            return mappings;
        } catch (e) {
            lastError = e;
            console.error(`Failed to list port mappings using controlURL ${controlURL}`, e);
        }
    }
    throw new Error(`Failed to list port mappings, could not find a working controlURL. Last error: ${(lastError as Error)?.stack ?? lastError}`);
}

// We forward with a PERMANENT lease (leaseDuration 0) rather than a finite one that we renew.
//  A finite lease can't be refreshed gap-free on real routers: an in-place AddPortMapping while
//  the lease is active is silently ignored (returns 200 but the lease keeps ticking to zero), and
//  the only way to reset it — delete then re-add — leaves a window where the port isn't forwarded.
//  A permanent mapping never expires, so there's nothing to renew and no gap. (Verified against a
//  live IGD; see test.ts.)
const PERMANENT_LEASE = 0;

// A permanent mapping never expires, so we don't renew. We only watch, on this interval, for
//  another application having superseded our forward (or a router reboot having wiped it), and log
//  loudly if so. We do NOT re-take it — last writer wins, so fighting back would just be a war.
const SUPERSEDE_CHECK_INTERVAL = timeInMinute * 30;

/** Outcome of forwardPort. `owned` is true once we hold the router mapping for the port. When
 *      false, `reason` says why: "declined" = noPortStealing and another host holds the port (the
 *      caller should try a different port); "error" = UPnP unreachable / create failed (best-effort,
 *      nothing forwarded but the caller can carry on). */
export type ForwardPortResult = {
    owned: boolean;
    reason?: "declined" | "error";
};

export async function forwardPort(config: {
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
}): Promise<ForwardPortResult> {
    const { externalPort, internalPort } = config;
    let duration = config.duration ?? PERMANENT_LEASE;
    let permanent = duration === PERMANENT_LEASE;

    // Take ownership of the router's mapping for this external port: delete whatever's there (a
    //  stale mapping of ours, or another host's) so our AddPortMapping isn't rejected as a conflict
    //  (718), then install our mapping. This makes the last writer win — whichever application
    //  forwards most recently owns the port. With noPortStealing we first bail out if the existing
    //  mapping belongs to someone else, leaving it untouched.
    // Our current mapping for this external port (TCP), from a fresh listing.
    async function readMapping(): Promise<PortMapping | undefined> {
        return (await listPortMappings()).find(m => m.externalPort === externalPort && m.protocol.toUpperCase() === "TCP");
    }

    async function takeOwnership(): Promise<ForwardPortResult> {
        try {
            const { internalIP, gatewayIP, controlPort, controlURLs } = await resolveGateway();

            // One listing up front: tells us who currently owns the port (for noPortStealing) and
            //  whether a mapping exists at all (so we only delete when there's something to delete).
            let existing = await readMapping();

            if (existing && existing.internalClient !== internalIP && config.noPortStealing) {
                console.log(`Port ${externalPort} is already forwarded to ${existing.internalClient} (not us); not stealing it (noPortStealing).`);
                return { owned: false, reason: "declined" };
            }

            // Already exactly what we want (ours, permanent, right internal port) — don't churn it.
            if (existing && existing.internalClient === internalIP && existing.internalPort === internalPort && permanent && existing.leaseDuration === 0) {
                return { owned: true };
            }

            // Only delete when a mapping already exists (deleting a missing entry just errors 714,
            //  and a free port needs no delete). Once one exists we clear it so our AddPortMapping
            //  isn't rejected as a conflict (718) — this is also what makes the last writer win.
            let needDelete = !!existing;
            for (let controlURL of controlURLs) {
                try {
                    if (needDelete) {
                        await deletePortMapping({ externalPort, gatewayIP, controlPort, controlPath: controlURL }).catch(() => { });
                    }
                    await createPortMapping({
                        externalPort, internalPort,
                        gatewayIP,
                        controlPort,
                        controlPath: controlURL,
                        internalIP,
                        duration,
                    });
                    // AddPortMapping can return 200 on a control URL that isn't the real WAN
                    //  connection service without actually taking effect, so confirm the mapping is
                    //  now ours before trusting it; otherwise move on and try the next control URL.
                    let after = await readMapping();
                    if (after && after.internalClient === internalIP) {
                        console.log(`Port mapping created on ${gatewayIP}:${externalPort} -> ${internalIP}:${internalPort}`);
                        return { owned: true };
                    }
                    console.error(`AddPortMapping on ${controlURL} reported success but ${externalPort} isn't forwarded to us; trying the next control URL`);
                } catch (e) {
                    console.error(`Failed to create port mapping using controlURL ${controlURL}`, e);
                }
            }
            // Not a port-contention issue — the port itself is fine, we just couldn't program the
            //  router. Return "error" (not "declined") so the caller keeps this port rather than
            //  scanning for another one; the console.errors above are the record of what went wrong.
            console.error(`Failed to create port mapping for ${externalPort} on any control URL (${controlURLs.join(", ")})`);
        } catch (e) {
            console.error("Error in forwardPort", e);
        }
        return { owned: false, reason: "error" };
    }

    // Re-read the mapping and warn if we no longer own it. Compares against our CURRENT LAN IP, so
    //  this also catches the case where our own IP changed out from under the old mapping.
    async function warnIfSuperseded() {
        try {
            let currentIP = await getLocalInternalIP();
            let ours = (await listPortMappings()).find(m => m.externalPort === externalPort && m.protocol.toUpperCase() === "TCP");
            if (!ours) {
                console.error(`Port forward ${externalPort} is gone — the mapping was removed (router reboot, or another host deleted it).`);
            } else if (currentIP && ours.internalClient !== currentIP) {
                console.error(`Port forward ${externalPort} was superseded — it now forwards to ${ours.internalClient} instead of us (${currentIP}). Another application has taken the port.`);
            }
        } catch (e) {
            console.error(`Failed to check port forward ${externalPort} for supersession`, (e as Error).stack ?? e);
        }
    }

    let result = await takeOwnership();

    // Only monitor permanent mappings we actually own. A finite lease is expected to expire, so its
    //  disappearance isn't a supersession worth warning about; a declined/failed claim owns nothing.
    if (result.owned && permanent) {
        // unref so a script that only wants a one-off forward (and then exits) isn't held open by
        //  the monitor timer; a running server stays alive on its own and the checks keep firing.
        let timer = setInterval(() => {
            void warnIfSuperseded();
        }, SUPERSEDE_CHECK_INTERVAL);
        timer.unref?.();
    }

    return result;
}

/** Our machine's LAN IP, as the router sees it — used to tell whether an existing port
 *      mapping points at us or at a different machine on the network. */
export async function getLocalInternalIP(): Promise<string | undefined> {
    return getOutboundIP();
}

/** True when our outbound address is private/CGNAT — i.e. a NAT sits between us and the
 *      internet, so forwarding a port is worthwhile. A public outbound address means we're
 *      directly reachable and forwarding is unnecessary. This is the cross-platform gate that
 *      replaced the old "skip forwarding on linux" check, so Linux hosts behind NAT forward. */
export async function isBehindNAT(): Promise<boolean> {
    let ip = await getOutboundIP();
    if (!ip) {
        return false;
    }
    return isPrivateIPv4(ip);
}

// RFC-1918 private ranges, plus 100.64/10 (carrier-grade NAT) and 169.254/16 (link-local).
//  Any of these as our outbound address means there's a NAT between us and the internet.
function isPrivateIPv4(ip: string): boolean {
    let parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some(n => !Number.isInteger(n))) {
        return false;
    }
    let [a, b] = parts;
    return (
        a === 10 ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254)
    );
}

// The source IPv4 the kernel would use to reach the internet. Connecting a UDP socket runs a
//  route lookup that assigns the local address without sending any packets, so it picks the
//  correct interface even when several exist (VPN, docker, ...). Falls back to scanning the
//  interface list when the route probe can't run.
async function getOutboundIP(): Promise<string | undefined> {
    let viaRoute = await new Promise<string | undefined>(resolve => {
        const socket = dgram.createSocket("udp4");
        let finish = (ip: string | undefined) => {
            try {
                socket.close();
            } catch {
            }
            resolve(ip);
        };
        socket.on("error", () => finish(undefined));
        try {
            socket.connect(53, "8.8.8.8", () => finish(socket.address().address));
        } catch {
            finish(undefined);
        }
    });
    if (viaRoute) {
        return viaRoute;
    }

    for (let addrs of Object.values(os.networkInterfaces())) {
        for (let addr of addrs ?? []) {
            if (addr.family === "IPv4" && !addr.internal) {
                return addr.address;
            }
        }
    }
    return undefined;
}

function discoverGateway(localAddress: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const socket = dgram.createSocket("udp4");
        let isResolved = false;

        if (!localAddress) {
            reject(new Error("Could not find a suitable local address"));
            return;
        }

        socket.on("message", (msg) => {
            const response = msg.toString();
            const location = response.match(/LOCATION: (.*)\r\n/i);
            if (location && location[1]) {
                isResolved = true;
                socket.close();
                resolve(location[1]);
            }
        });

        socket.on("error", (err) => {
            socket.close();
            if (!isResolved) {
                reject(err);
            }
        });

        socket.on("listening", () => {
            socket.addMembership("239.255.255.250", localAddress);
        });

        socket.bind({ address: localAddress }, () => {
            socket.setBroadcast(true);
            socket.send(SSDP_DISCOVER_MSG, 0, SSDP_DISCOVER_MSG.length, 1900, "239.255.255.250");
        });

        setTimeout(() => {
            if (!isResolved) {
                socket.close();
                reject(new Error(`SSDP discovery timeout. Search on ${localAddress}`));
            }
        }, SSDP_DISCOVER_MX * 1000);
    });
}

async function getControlPaths(gateway: string) {
    let xml = await (await fetch(gateway)).text();
    const controlURLRegex = /<controlURL>(.*?)<\/controlURL>/g;
    const matches = [];
    let match;
    while ((match = controlURLRegex.exec(xml)) !== null) {
        matches.push(match[1]);
    }
    matches.reverse();
    return matches;
}

export async function createPortMapping(config: {
    externalPort: number;
    internalPort: number;
    gatewayIP: string;
    controlPort: number;
    controlPath: string;
    internalIP: string;
    duration: number;
}): Promise<void> {
    const { externalPort, internalPort, internalIP, controlPath, controlPort, gatewayIP } = config;
    const action = "\"urn:schemas-upnp-org:service:WANIPConnection:1#AddPortMapping\"";

    const soapBody = `
        <?xml version="1.0"?>
        <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
            <s:Body>
                <u:AddPortMapping xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1">
                    <NewRemoteHost></NewRemoteHost>
                    <NewExternalPort>${externalPort}</NewExternalPort>
                    <NewProtocol>TCP</NewProtocol>
                    <NewInternalPort>${internalPort}</NewInternalPort>
                    <NewInternalClient>${internalIP}</NewInternalClient>
                    <NewEnabled>1</NewEnabled>
                    <NewPortMappingDescription>My Port Mapping</NewPortMappingDescription>
                    <NewLeaseDuration>${Math.ceil(config.duration / 1000)}</NewLeaseDuration>
                </u:AddPortMapping>
            </s:Body>
        </s:Envelope>
    `;

    const res = await fetch(`http://${gatewayIP}:${controlPort}${controlPath}`, {
        method: "POST",
        headers: {
            "Content-Type": "text/xml; charset=\"utf-8\"",
            "SOAPAction": action,
            "Content-Length": Buffer.byteLength(soapBody) + "",
        },
        body: soapBody
    });

    if (res.status !== 200) {
        const data = await res.text();
        throw new Error(`Failed to create port mapping: ${data}`);
    }
}

export async function deletePortMapping(config: {
    externalPort: number;
    gatewayIP: string;
    controlPort: number;
    controlPath: string;
}): Promise<void> {
    const { externalPort, controlPath, controlPort, gatewayIP } = config;
    const action = "\"urn:schemas-upnp-org:service:WANIPConnection:1#DeletePortMapping\"";

    const soapBody = `
        <?xml version="1.0"?>
        <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
            <s:Body>
                <u:DeletePortMapping xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1">
                    <NewRemoteHost></NewRemoteHost>
                    <NewExternalPort>${externalPort}</NewExternalPort>
                    <NewProtocol>TCP</NewProtocol>
                </u:DeletePortMapping>
            </s:Body>
        </s:Envelope>
    `;

    const res = await fetch(`http://${gatewayIP}:${controlPort}${controlPath}`, {
        method: "POST",
        headers: {
            "Content-Type": "text/xml; charset=\"utf-8\"",
            "SOAPAction": action,
            "Content-Length": Buffer.byteLength(soapBody) + "",
        },
        body: soapBody
    });

    if (res.status !== 200) {
        const data = await res.text();
        throw new Error(`Failed to delete port mapping: ${data}`);
    }
}

// UPnP returns this error code when we walk past the last mapping index, which is how
//  we detect the end of the list rather than a real failure.
const UPNP_ARRAY_INDEX_INVALID = 713;

/** Fetches a single port mapping by its index. Returns undefined once the index is past
 *      the end of the table (the router's signal that there are no more entries). */
async function getGenericPortMappingEntry(config: {
    gatewayIP: string;
    controlPort: number;
    controlPath: string;
    index: number;
}): Promise<PortMapping | undefined> {
    const { gatewayIP, controlPort, controlPath, index } = config;
    const action = "\"urn:schemas-upnp-org:service:WANIPConnection:1#GetGenericPortMappingEntry\"";

    const soapBody = `
        <?xml version="1.0"?>
        <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
            <s:Body>
                <u:GetGenericPortMappingEntry xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1">
                    <NewPortMappingIndex>${index}</NewPortMappingIndex>
                </u:GetGenericPortMappingEntry>
            </s:Body>
        </s:Envelope>
    `;

    const res = await fetch(`http://${gatewayIP}:${controlPort}${controlPath}`, {
        method: "POST",
        headers: {
            "Content-Type": "text/xml; charset=\"utf-8\"",
            "SOAPAction": action,
            "Content-Length": Buffer.byteLength(soapBody) + "",
        },
        body: soapBody
    });

    const data = await res.text();
    if (res.status !== 200) {
        let errorCode = Number(data.match(/<errorCode>(\d+)<\/errorCode>/)?.[1]);
        if (errorCode === UPNP_ARRAY_INDEX_INVALID) {
            return undefined;
        }
        throw new Error(`Failed to get port mapping entry ${index}: ${res.status} ${data}`);
    }

    let getField = (name: string) => data.match(new RegExp(`<${name}>(.*?)</${name}>`, "s"))?.[1] ?? "";
    return {
        externalPort: Number(getField("NewExternalPort")),
        internalPort: Number(getField("NewInternalPort")),
        protocol: getField("NewProtocol"),
        internalClient: getField("NewInternalClient"),
        remoteHost: getField("NewRemoteHost"),
        enabled: getField("NewEnabled") === "1",
        description: getField("NewPortMappingDescription"),
        leaseDuration: Number(getField("NewLeaseDuration")),
    };
}
