import debugbreak from "debugbreak";
import * as dgram from "dgram";
import os from "os";
import { timeInHour } from "./misc";

const SSDP_DISCOVER_MX = 2;
const SSDP_DISCOVER_MSG = `M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: ${SSDP_DISCOVER_MX}\r\nST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n\r\n`;

export async function forwardPort(config: {
    externalPort: number;
    internalPort: number;
    duration?: number;
}) {
    try {
        const { externalPort, internalPort } = config;
        let duration = config.duration ?? timeInHour;

        const localObj = getLocalInterfaceAddress();
        if (!localObj) throw new Error("Could not find the local address / gateway");

        const { internalIP, gatewayIP } = localObj;
        console.log(`Local IP: ${internalIP}, Gateway IP: ${gatewayIP}`);
        let gateway = await discoverGateway(internalIP);
        let controlURLs = await getControlPaths(gateway);
        let controlPort = Number(new URL(gateway).port);

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
            const routeOutput = require("child_process")("ip route show default").toString();
            gatewayMatch = routeOutput.match(/default via (\d+\.\d+\.\d+\.\d+)/);
        } catch (err) {
            console.error("Failed to execute 'ip route show default', trying fallback", err);
        }

        if (!gatewayMatch) {
            try {
                // Fallback to "netstat -rn" for older systems
                const netstatOutput = require("child_process")("netstat -rn").toString();
                gatewayMatch = netstatOutput.match(/default\s+(\d+\.\d+\.\d+\.\d+)/);
            } catch (err) {
                console.error("Failed to execute 'netstat -rn', unable to find gateway", err);
            }
        }

        if (gatewayMatch) {
            try {
                // Use "ip addr" to get internal IP (more universal)
                const ipOutput = require("child_process")("ip addr").toString();
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
