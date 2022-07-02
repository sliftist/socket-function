import { SocketFunction } from "./SocketFunction";

class Test {
    memberVariable = 5;

    async fnc(test: number): Promise<void> {}
    fncNotAsync(test: number): void {}
}

export const TestClass = SocketFunction.register(
    "80d9f328-72df-4baa-8be8-019c1003d4a2",
    Test,
    {
        fnc: {
            hooks: [
                async (config) => {
                    config.socket.callContext
                    config.socket.callerNodeId
                    config.args = [1];
                    config.overrideResult = true;
                }
            ]
        },
        //fncNotAsync: {},
        //notAFnc: {},
    }
);

void TestClass.nodes[""].fnc(5).then(() => {

});