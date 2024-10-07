import { getExternalIP } from "./src/networking";
import http from "http";
import * as dgram from "dgram";
import os from "os";
import debugbreak from "debugbreak";
import { forwardPort } from "./src/forwardPort";


// Usage example:
async function main() {
    const externalPort = 11300;
    const internalPort = externalPort;

    await forwardPort({ externalPort, internalPort });

    // Listen on the external port
    // const server = http.createServer((req, res) => {
    //     console.log("Request received");
    //     res.end("Hello, world!");
    // });
    // server.listen(externalPort, "0.0.0.0");

    // {
    //     const externalIP = await getExternalIP();
    //     let test = await fetch(`http://${externalIP}:${externalPort}`);
    //     console.log(await test.text());
    // }


    //await createPortMapping({ externalPort, internalPort, gateWayIP, internalIP, });
}

main().catch(e => console.error(e));