import debugbreak from "debugbreak";
import * as dgram from "dgram";
import os from "os";
import { timeInHour } from "./misc";

const SSDP_DISCOVER_MX = 2;
const SSDP_DISCOVER_MSG = `M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: ${SSDP_DISCOVER_MX}\r\nST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n\r\n`;

/** Resolves the UPnP Internet Gateway Device we can talk to, along with the local
 *      addressing needed to build SOAP requests against it. Shared by every operation
 *      that needs to reach the router's control endpoint. */
async function resolveGateway(): Promise<{
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

export async function forwardPort(config: {
    externalPort: number;
    internalPort: number;
    duration?: number;
}) {
    try {
        const { externalPort, internalPort } = config;
        let duration = config.duration ?? timeInHour;

        const { internalIP, gatewayIP, controlPort, controlURLs } = await resolveGateway();

        for (let controlURL of controlURLs) {
            try {
                await createPortMapping({
                    externalPort, internalPort,
                    gatewayIP,
                    controlPort,
                    controlPath: controlURL,
                    internalIP,
                    duration,
                });
                console.log(`Port mapping created on ${gatewayIP}:${externalPort} -> ${internalIP}:${internalPort}`);
                return;
            } catch (e) {
                console.error(`Failed to create port mapping using controlURL ${controlURL}`, e);
            }
        }
        console.error("Failed to create port mapping, could not find controlURL");
    } catch (e) {
        console.error("Error in forwardPort", e);
    }
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

async function createPortMapping(config: {
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
