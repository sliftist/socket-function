import * as net from "net";
import * as tls from "tls";
import * as dns from "dns";
import { httpsRequest } from "./https";

const HOST = "a.querysubtest.com";
// 443 is expected to serve HTTPS; the rest are expected to have nothing listening.
const OPEN_PORT = 443;
const CLOSED_PORTS = [444, 8443, 12345];
// Hostnames that cannot resolve: an NXDOMAIN subdomain of a real zone, and the reserved .invalid TLD.
const BAD_HOSTS = ["nonexistent-abc123.querysubtest.com", "this-cannot-resolve.invalid"];

// Probe the raw socket layer directly, so we can see exactly which errno a not-listening port produces
//  (the specific concern: ECONNRESET vs ECONNREFUSED/ETIMEDOUT). This bypasses our retry/DNS logic.
async function probeRaw(host: string, port: number, useTls: boolean): Promise<string> {
    return new Promise(resolve => {
        let start = Date.now();
        let socket = useTls
            ? tls.connect({ host, port, servername: host, rejectUnauthorized: false })
            : net.connect({ host, port });
        let done = (result: string) => {
            let elapsed = Date.now() - start;
            socket.destroy();
            resolve(`${result} (${elapsed}ms)`);
        };
        socket.once(useTls ? "secureConnect" : "connect", () => done("CONNECTED"));
        socket.once("error", (e: NodeJS.ErrnoException) => done(`error code=${e.code} message=${e.message}`));
        setTimeout(() => done("TIMED OUT after 10s"), 10_000);
    });
}

async function tryHttps(url: string): Promise<string> {
    let start = Date.now();
    try {
        let result = await httpsRequest(url);
        return `OK ${result.length} bytes (${Date.now() - start}ms)`;
    } catch (e) {
        let err = e as NodeJS.ErrnoException;
        return `FAILED code=${err.code} (${Date.now() - start}ms)\n    ${(err.stack ?? String(err)).split("\n").slice(0, 3).join("\n    ")}`;
    }
}

// Show what dns.resolve4 does with a bad name directly, so we can see the errno our resolve loop retries on.
async function probeResolve(host: string): Promise<string> {
    let start = Date.now();
    try {
        let addrs = await dns.promises.resolve4(host);
        return `resolved ${JSON.stringify(addrs)} (${Date.now() - start}ms)`;
    } catch (e) {
        let err = e as NodeJS.ErrnoException;
        return `error code=${err.code} (${Date.now() - start}ms)`;
    }
}

async function main() {
    console.log(`=== Raw socket probes (which errno does a closed port give?) ===`);
    console.log(`  ${HOST}:${OPEN_PORT} (tls)   -> ${await probeRaw(HOST, OPEN_PORT, true)}`);
    for (let port of CLOSED_PORTS) {
        console.log(`  ${HOST}:${port} (tcp) -> ${await probeRaw(HOST, port, false)}`);
        console.log(`  ${HOST}:${port} (tls) -> ${await probeRaw(HOST, port, true)}`);
    }

    console.log(`\n=== httpsRequest (full path: DNS cache + retry) ===`);
    console.log(`  https://${HOST}:${OPEN_PORT}/   -> ${await tryHttps(`https://${HOST}:${OPEN_PORT}/`)}`);
    for (let port of CLOSED_PORTS) {
        console.log(`  https://${HOST}:${port}/ -> ${await tryHttps(`https://${HOST}:${port}/`)}`);
    }

    console.log(`\n=== Bad hostnames (resolve loop + ENOTFOUND retry path) ===`);
    for (let host of BAD_HOSTS) {
        console.log(`  dns.resolve4(${host}) -> ${await probeResolve(host)}`);
        console.log(`  https://${host}/ -> ${await tryHttps(`https://${host}/`)}`);
    }
}

main().then(() => process.exit(0), e => { console.error(e.stack ?? e); process.exit(1); });
