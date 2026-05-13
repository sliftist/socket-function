// Negotiates connection-level flags via Sec-WebSocket-Protocol on the WebSocket
// upgrade handshake. The client proposes every flag combination it accepts (hex-
// encoded so the value is a valid HTTP token). The server picks the first value
// whose target nodeId matches its own, then returns it verbatim. If none match,
// the server returns no protocol and the handshake fails — which is exactly the
// rejection semantics we want (indistinguishable from "node not reachable").

const PROTOCOL_VERSION = "v1";

export type ConnectionFlags = {
    // Client supports receiving LZ4-compressed frames
    clientLZ4: boolean;
    // Server supports receiving LZ4-compressed frames (i.e. server can accept LZ4)
    serverLZ4: boolean;
};

export type DecodedProtocol = {
    target: string;
    flags: ConnectionFlags;
};

function hexEncode(s: string): string {
    return Buffer.from(s, "utf8").toString("hex");
}
function hexDecode(s: string): string {
    return Buffer.from(s, "hex").toString("utf8");
}

function encodeFlagBit(b: boolean): string { return b ? "1" : "0"; }

// An empty-string target encodes "match any server nodeId" — used for
// browser clients which don't know our internal nodeId because they're
// connecting through a Let's Encrypt cert on a public domain.
const WILDCARD_TARGET = "";

function encodeOne(target: string, flags: ConnectionFlags): string {
    let plain = `${PROTOCOL_VERSION}|${target}|clz4=${encodeFlagBit(flags.clientLZ4)}|slz4=${encodeFlagBit(flags.serverLZ4)}`;
    return hexEncode(plain);
}

export function decodeProtocol(hex: string): DecodedProtocol | undefined {
    if (!/^[0-9a-fA-F]+$/.test(hex)) return undefined;
    let plain: string;
    try {
        plain = hexDecode(hex);
    } catch {
        return undefined;
    }
    let parts = plain.split("|");
    if (parts.length < 2) return undefined;
    if (parts[0] !== PROTOCOL_VERSION) return undefined;
    let target = parts[1];
    let flags: ConnectionFlags = { clientLZ4: false, serverLZ4: false };
    for (let i = 2; i < parts.length; i++) {
        let [k, v] = parts[i].split("=");
        if (k === "clz4") flags.clientLZ4 = v === "1";
        else if (k === "slz4") flags.serverLZ4 = v === "1";
    }
    return { target, flags };
}

// Build the list of subprotocol values the client wants to propose. We enumerate
// every flag combination the client accepts — the server will pick whichever
// one it can serve (matching its own flag support). Caller is responsible for
// not proposing flags it can't handle.
//
// `target` is the nodeId the client wants to reach. Pass undefined for browser
// clients (or any context where the client doesn't know the server's nodeId,
// because it's reaching the server through a public DNS name + Let's Encrypt
// cert). The server then accepts the connection regardless of its identity,
// while still negotiating flags.
export function proposeProtocols(target: string | undefined, clientCapabilities: { lz4: boolean }): string[] {
    let out: string[] = [];
    let clientLZ4Options = clientCapabilities.lz4 ? [true, false] : [false];
    let serverLZ4Options = [true, false];
    let encodedTarget = target ?? WILDCARD_TARGET;
    for (let clientLZ4 of clientLZ4Options) {
        for (let serverLZ4 of serverLZ4Options) {
            out.push(encodeOne(encodedTarget, { clientLZ4, serverLZ4 }));
        }
    }
    return out;
}

// Server-side: given the proposed (hex-encoded) subprotocol values from the
// client, the server's own nodeId, and the server's capabilities — pick the
// first value matching this server with a flag combo we can support. Returns
// the chosen hex string verbatim (so the server echoes it back), or undefined
// to signal no match → reject the handshake.
//
// A proposal with target === WILDCARD_TARGET ("") matches any server (used
// by browsers that don't know our internal nodeId).
export function chooseProtocol(
    proposed: string[],
    serverNodeId: string,
    serverCapabilities: { lz4: boolean }
): string | undefined {
    for (let hex of proposed) {
        let decoded = decodeProtocol(hex);
        if (!decoded) continue;
        if (decoded.target !== WILDCARD_TARGET && decoded.target !== serverNodeId) continue;
        // Server capability check: if the proposal asks the server to receive
        // LZ4 (slz4=1) but the server doesn't support it, skip.
        if (decoded.flags.serverLZ4 && !serverCapabilities.lz4) continue;
        return hex;
    }
    return undefined;
}
