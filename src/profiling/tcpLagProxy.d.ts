export declare function tcpLagProxy(config: {
    localPort: number;
    remoteHost: string;
    remotePort: number;
    lag: number;
    networkWriteSize?: {
        value: number;
    };
    networkReadSize?: {
        value: number;
    };
    networkWritePackets?: {
        value: number;
    };
    networkReadPackets?: {
        value: number;
    };
}): Promise<void>;
