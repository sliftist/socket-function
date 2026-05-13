export type ConnectionFlags = {
    clientLZ4: boolean;
    serverLZ4: boolean;
};
export type DecodedProtocol = {
    target: string;
    flags: ConnectionFlags;
};
export declare function decodeProtocol(hex: string): DecodedProtocol | undefined;
export declare function proposeProtocols(target: string | undefined, clientCapabilities: {
    lz4: boolean;
}): string[];
export declare function chooseProtocol(proposed: string[], serverNodeId: string, serverCapabilities: {
    lz4: boolean;
}): string | undefined;
