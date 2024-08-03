import * as dgram from "dgram";
import os from "os";

const SSDP_DISCOVER_MX = 2;
const SSDP_DISCOVER_MSG = `M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: ${SSDP_DISCOVER_MX}\r\nST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n\r\n`;

export async function forwardPort(config: {
    externalPort: number;
    internalPort: number;
}) {
    const { externalPort, internalPort } = config;

    const localObj = getLocalInterfaceAddress();
    if (!localObj) throw new Error("Could not find the local address / gateway");

    const { internalIP, gatewayIP } = localObj;
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
            });
            return;
        } catch (e) {
            console.error(e);
        }
    }
    console.error("Failed to create port mapping, could not find controlURL");
}

function getLocalInterfaceAddress(): { internalIP: string; gatewayIP: string; } | undefined {
    const interfaces = os.networkInterfaces() as any;
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === "IPv4" && !iface.internal) {
                // TOOD: Correctly resolve the cidr?
                let gatewayIP = iface.cidr.split(".").slice(0, 3).join(".") + ".1";
                // TOOD: We try discovery on all gateways, so we can know for sure which one it is
                //  (and maybe even port forward all gateway, if multiple respond?)
                if (gatewayIP.startsWith("10.0.0") || gatewayIP.startsWith("10.0.1") || gatewayIP.startsWith("192.168.0")) {
                    return { internalIP: iface.address, gatewayIP };
                }
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
                    <NewLeaseDuration>0</NewLeaseDuration>
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
