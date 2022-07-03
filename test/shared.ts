import { getArgs } from "../src/args";
import { SocketFunction } from "../SocketFunction";

import "typenode";
module.moduleContents;

class TestBase {
    memberVariable = 5;

    async add(lhs: number, rhs: number) {
        let caller = Test.context.caller?.nodeId;
        if (!caller) {
            throw new Error("No caller?");
        }
        console.log(`Caller is ${caller}`);
        return lhs + rhs;
    }

    async callMe() {
        let caller = Test.context.caller?.nodeId;
        if (!caller) {
            throw new Error("No caller?");
        }
        console.log(`Caller is ${caller}`);
        void (async () => {
            let seqNum = 1;
            while (true) {
                console.log(`Calling client at ${seqNum}`);
                await Test.nodes[caller].callBack();
                await new Promise(resolve => setTimeout(resolve, 1000));
                seqNum++;
            }
        })();
    }

    async callBack() {
        console.log(`Got callback at ${Date.now()}`);
    }
}

export const Test = SocketFunction.register(
    "80d9f328-72df-4baa-8be8-019c1003d4a2",
    new TestBase(),
    {
        add: {
            // hooks: [
            //     async (config) => {

            //     }
            // ]
        },
        callMe: {
            clientHooks: [
                async (config) => {
                    config.call.reconnectTimeout = 2000;
                }
            ]
        },
        callBack: {

        },
        //fncNotAsync: {},
        //notAFnc: {},
    }
);