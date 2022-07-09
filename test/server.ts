// import debugbreak from "debugbreak";
// debugbreak(1);
// debugger;

import { RequireController } from "../require/RequireController";
import { SocketFunction } from "../SocketFunction";
import { getArgs } from "../src/args";
import { Test } from "./shared";
import path from "path";
import { compileTransform, compileTransformBefore } from "typenode";

// Must add CSS shim before we import any clientside files
//  NOTE: The css shim only need to run serverside, as clientside doesn't run compilation,
//      and instead just copies serverside module contents.
import "../require/CSSShim";

// Import clientside files, so they can be whitelisted
import "./client";


void main();

async function main() {
    SocketFunction.expose(Test);

    RequireController._classGuid;
    SocketFunction.expose(RequireController);

    SocketFunction.setDefaultHTTPCall(RequireController, "requireHTML", "./test/client");

    const port = 2542;

    await SocketFunction.mount({ port });
}
