import * as crypto from "crypto";

export function convertErrorStackToError(error: string): Error {
    let errorObj = new Error();
    errorObj.stack = String(error);
    errorObj.message = String(error).split("\n")[0].slice("Error: ".length);
    return errorObj;
}

export function sha256Hash(buffer: Buffer | string) {
    return crypto.createHash("sha256").update(buffer).digest("hex");
}
/** Async, but works both clientside and serverside. */
export async function sha256HashPromise(buffer: Buffer) {
    if (isNode()) {
        return crypto.createHash("sha256").update(buffer).digest("hex");
    } else {
        let buf = await window.crypto.subtle.digest("SHA-256", buffer);
        return Buffer.from(buf).toString("hex");
    }
}


export function arrayEqual(a: unknown[], b: unknown[]) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}
export function isNode() {
    return typeof document === "undefined";
}

export function isNodeTrue() {
    return isNode() as true;
}

export function formatNumberSuffixed(count: number): string {
    if (typeof count !== "number") return "0";
    if (count < 0) {
        return "-" + formatNumberSuffixed(-count);
    }

    let absValue = Math.abs(count);

    const extraFactor = 10;
    let divisor = 1;
    let suffix = "";
    if (absValue < 1000 * extraFactor) {

    } else if (absValue < 1000 * 1000 * extraFactor) {
        suffix = "K";
        divisor = 1000;
    } else if (absValue < 1000 * 1000 * 1000 * extraFactor) {
        suffix = "M";
        divisor = 1000 * 1000;
    } else {
        suffix = "B";
        divisor = 1000 * 1000 * 1000;
    }
    count /= divisor;
    absValue /= divisor;

    return Math.round(count).toString() + suffix;
}

if (isNode()) {
    // TODO: Find a better place for this...
    process.on("unhandledRejection", async (reason: any, promise) => {
        console.error(`Uncaught promise rejection: ${String(reason.stack || reason)}`);
    });
}