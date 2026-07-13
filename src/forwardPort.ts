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
    const localObj = getLocalInterfaceAddress();
    if (!localObj) throw new Error("Could not find the local address / gateway");

    const { internalIP, gatewayIP } = localObj;
    console.log(`Local IP: ${internalIP}, Gateway IP: ${gatewayIP}`);
    let gateway = await discoverGateway(internalIP);
    let controlURLs = await getControlPaths(gateway);
    let controlPort = Number(new URL(gateway).port);

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
    if (os.platform() === "linux") return [];

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
    // On linux, just return, the server probably doesn't require forwarding, and if it does,
    //  it probably this code probably won't work anyways.
    if (os.platform() === "linux") return;
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
export function getLocalInternalIP(): string | undefined {
    return getLocalInterfaceAddress()?.internalIP;
}

function getLocalInterfaceAddress(): { internalIP: string; gatewayIP: string; } | undefined {
    let looksLikeRouter = (ip: string) => ip.startsWith("10.0.0") || ip.startsWith("10.0.1") || ip.startsWith("192.168.0");

    // On windows, run `ipconfig` and parse the output
    // Otherwise, ifconfig
    if (os.platform() === "win32") {
        let output = require("child_process").execSync("ipconfig").toString();
        let sections = output.split("\r\n\r\n");

        for (let section of sections) {
            if (section.includes("IPv4 Address")) {
                let ipv4Match = section.match(/IPv4 Address[.\s]*: ([\d.]+)/);
                let gatewayMatch = section.match(/Default Gateway[.\s]*: ([\d.]+)/);

                if (ipv4Match && gatewayMatch && looksLikeRouter(gatewayMatch[1])) {
                    return {
                        internalIP: ipv4Match[1],
                        gatewayIP: gatewayMatch[1]
                    };
                }
            }
        }
    } else {
        let gatewayMatch: RegExpMatchArray | undefined;
        try {
            // Attempt to get the gateway using "ip route" command (more universal)
            const routeOutput = require("child_process").execSync("ip route show default").toString();
            gatewayMatch = routeOutput.match(/default via (\d+\.\d+\.\d+\.\d+)/);
        } catch (err) {
            console.error("Failed to execute 'ip route show default', trying fallback", err);
        }

        if (!gatewayMatch) {
            try {
                // Fallback to "netstat -rn" for older systems
                const netstatOutput = require("child_process").execSync("netstat -rn").toString();
                gatewayMatch = netstatOutput.match(/default\s+(\d+\.\d+\.\d+\.\d+)/);
            } catch (err) {
                console.error("Failed to execute 'netstat -rn', unable to find gateway", err);
            }
        }

        if (gatewayMatch) {
            try {
                // Use "ip addr" to get internal IP (more universal)
                const ipOutput = require("child_process").execSync("ip addr").toString();
                const ipMatch = ipOutput.match(/inet (?!127\.0\.0\.1)(\d+\.\d+\.\d+\.\d+)\//);

                if (ipMatch) {
                    return {
                        internalIP: ipMatch[1],
                        gatewayIP: gatewayMatch[1]
                    };
                } else {
                    console.error("Failed to match internal IP");
                }
            } catch (err) {
                console.error("Failed to execute 'ip addr'", err);
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
