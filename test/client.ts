/// <reference path="../require/RequireController.ts" />

// https://letx.ca:2542/?classGuid=RequireController-e2f811f3-14b8-4759-b0d6-73f14516cf1d&functionName=requireHTML&args=[%22./test/test%22]

//import typescript from "typescript";

import debugbreak from "debugbreak";
import { setFlag } from "../require/compileFlags";
import { SocketFunction } from "../SocketFunction";
import { Test } from "./shared";

import "../require/CSSShim";
import "./client.css";
import { isNode } from "../src/misc";
import { getCallObj } from "../src/nodeProxy";

module.allowclient = true;

//console.log(typeof typescript);

//setFlag(require, "typescript", "allowclient", true);


void main();

async function main() {
    if (isNode()) return;

    SocketFunction.expose(Test);

    console.log("cool");

    const port = 2542;

    let serverId = await SocketFunction.connect({ port, address: "localhost" });
    let test = await Test.nodes[serverId].add(1, 2);
    console.log(`${test}=${1 + 2}`);

    // while (true) {
    //     let test = await TestClass.nodes[serverId].add(1, 2);
    //     console.log(`${test}=${1 + 2}`);
    //     await new Promise(resolve => setTimeout(resolve, 1000));
    // }

    await Test.nodes[serverId].callMe();
}
