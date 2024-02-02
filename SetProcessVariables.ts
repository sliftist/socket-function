module.allowclient = true;
import { isNode } from "./src/misc";

if (!isNode()) {
    process.env.CBOR_NATIVE_ACCELERATION_DISABLED = "true";
}