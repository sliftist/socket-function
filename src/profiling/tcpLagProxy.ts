import net from "net";
import { pipeline, PipelineTransform, PipelineTransformSource, Transform } from "stream";

export async function tcpLagProxy(config: {
    localPort: number;
    remoteHost: string;
    remotePort: number;
    // NOTE: Lag values between 1 and 10 are about the same, as setTimeout introduces a minimum delay.
    //  As a result lag values of 0 are about 2X faster than lag values of 1.
    lag: number;
    networkWriteSize?: { value: number };
    networkReadSize?: { value: number };
    networkWritePackets?: { value: number };
    networkReadPackets?: { value: number };
}) {
    const { localPort, remoteHost, remotePort, lag, networkWriteSize, networkReadSize, networkWritePackets, networkReadPackets } = config;
    let server = net.createServer();

    server.on("connection", async socket => {
        // Swallow all errors, as the pipe should handle it anyways?
        socket.on("error", () => { });
        if (lag > 0) {
            await new Promise(r => setTimeout(r, lag));
        }
        let remoteSocket = net.createConnection(remotePort, remoteHost);
        remoteSocket.on("error", () => { });

        const lagWrite = new Transform({
            transform(chunk, encoding, callback) {
                if (lag > 0) {
                    setTimeout(() => callback(undefined, chunk), lag);
                } else {
                    callback(undefined, chunk);
                }
            },
        });
        const lagRead = new Transform({
            transform(chunk, encoding, callback) {
                if (lag > 0) {
                    setTimeout(() => callback(undefined, chunk), lag);
                } else {
                    callback(undefined, chunk);
                }
            },
        });

        socket.pipe(lagWrite).pipe(remoteSocket);
        remoteSocket.pipe(lagRead).pipe(socket);

        socket.on("data", data => {
            if (networkWriteSize) networkWriteSize.value += data.length;
            if (networkWritePackets) networkWritePackets.value++;
        });
        remoteSocket.on("data", data => {
            if (networkReadSize) networkReadSize.value += data.length;
            if (networkReadPackets) networkReadPackets.value++;
        });
    });
    server.listen(localPort);
    return new Promise<void>((resolve, reject) => {
        server.on("listening", () => resolve());
        server.on("error", reject);
    });
}