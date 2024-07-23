import net from "net";
import { lazy } from "./caching";
import { httpsRequest } from "./https";
import { measureWrap } from "./profiling/measure";

export const testTCPIsListening = measureWrap(async function testTCPIsListening(host: string, port: number): Promise<boolean> {
    // We need to establish a TCP connection, then close it? Yeah... so it is
    //  not even a SocketFunction call, because it can't be, because that woule be TLS,
    //  which we can't do with an ip!
    let socket = net.connect({ host, port });
    return new Promise((resolve) => {
        socket.on("connect", () => {
            socket.end();
            resolve(true);
        });
        socket.on("error", () => {
            resolve(false);
        });
        setTimeout(() => {
            socket.end();
            resolve(false);
        }, 1000 * 60);
    });
});


const ipServers = [
    "http://quentinbrooks.com:4283",
    "https://ipinfo.io/ip",
    "https://api.ipify.org"
];

export const getExternalIP = lazy(measureWrap(async function getExternalIP(): Promise<string> {
    for (let server of ipServers) {
        try {
            return (await httpsRequest(server)).toString();
        } catch (e) {
            console.warn(`Failed to get external ip from ${server}: ${e}`);
        }
    }
    throw new Error(`Failed to get external ip from any server`);
}));

export const getPublicIP = getExternalIP;