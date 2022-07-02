import { getArgs } from "./args";
import { SocketFunction } from "./SocketFunction";

//todonext;
// Test the server and client
//  - I guess we will want to be able to namespace identifies so we can test
//      multiple on the same machine... Let's not use yargs, just argv parsing should be okay?

class Test {
    memberVariable = 5;

    async add(lhs: number, rhs: number) {
        return lhs + rhs;
    }

    async callMe() {
        let caller = TestClass.context.caller?.nodeId;
        if (!caller) {
            throw new Error("No caller?");
        }
        console.log(`Caller is ${caller}`);
        void (async () => {
            let seqNum = 1;
            while (true) {
                console.log(`Calling client at ${seqNum}`);
                await TestClass.nodes[caller].callBack();
                await new Promise(resolve => setTimeout(resolve, 1000));
                seqNum++;
            }
        })();
    }

    async callBack() {
        console.log(`Got callback at ${Date.now()}`);
    }
}

export const TestClass = SocketFunction.register(
    "80d9f328-72df-4baa-8be8-019c1003d4a2",
    Test,
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

void main();

//todonext
// - Get case where there will never be a reconnection working

async function main() {
    SocketFunction.expose(Test);
    const port = 2542;
    if (getArgs().identity === "server") {
        await SocketFunction.mount({ port });
    } else {
        let serverId = await SocketFunction.connect({ port, address: "localhost" });
        let test = await TestClass.nodes[serverId].add(1, 2);
        console.log(`${test}=${1 + 2}`);

        // while (true) {
        //     let test = await TestClass.nodes[serverId].add(1, 2);
        //     console.log(`${test}=${1 + 2}`);
        //     await new Promise(resolve => setTimeout(resolve, 1000));
        // }

        await TestClass.nodes[serverId].callMe();
    }
}
