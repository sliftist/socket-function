import * as crypto from "crypto";

export function convertErrorStackToError(error: string): Error {
    let errorObj = new Error();
    errorObj.stack = String(error);
    errorObj.message = String(error).split("\n")[0].slice("Error: ".length);
    return errorObj;
}

export function sha256Hash(buffer: Buffer) {
    return crypto.createHash("sha256").update(buffer).digest("hex");
}


export function arrayEqual(a: unknown[], b: unknown[]) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}


// TODO: Find a better place for this...
process.on("unhandledRejection", async (reason: any, promise) => {
    console.error(`Uncaught promise rejection: ${String(reason.stack || reason)}`);
});