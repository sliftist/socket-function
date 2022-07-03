import { lazy } from "./caching";

export const getArgs = lazy(() => {
    let args = process.argv.slice(2);
    let argObj: { [key: string]: string | undefined } = {};
    for (let arg of args) {
        if (arg.startsWith("-")) {
            arg = arg.slice(1);
        }
        if (arg.startsWith("-")) {
            arg = arg.slice(1);
        }
        if (arg.includes("=")) {
            let key = arg.split("=")[0];
            let value = arg.split("=").slice(1).join("=");
            argObj[key] = value;
        } else {
            argObj[arg] = "true";
        }
    }
    return argObj;
});