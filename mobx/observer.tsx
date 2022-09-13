import type preact from "preact";
import { setFlag } from "../require/compileFlags";

import { observable, Reaction } from "mobx";

setFlag(require, "mobx", "allowclient", true);
setFlag(require, "preact", "allowclient", true);

let globalConstructOrder = 0;

export function observer<
    T extends {
        new(...args: any[]): {
            render(): preact.ComponentChild;
            forceUpdate(callback?: () => void): void;
            componentWillUnmount?(): void;
        }
    }
>(
    Constructor: T
) {
    let name = Constructor.name;
    return class extends Constructor {
        // NOTE: This is completely valid javascript. For some reason (https://github.com/microsoft/TypeScript/pull/12065#issuecomment-270205513)
        //  the typescript team decided, whatever, just make it an error, even though it isn't in es6 ("we should simplify ES6' semantics").
        //  So, instead of simplifying ES6 semantics, lets give ourself better info for debugging...
        // @ts-ignore
        static get name() { return Constructor.name; }

        // It is always true, that a parent has a constructOrder < a child's constructOrder
        constructOrder = globalConstructOrder++;

        reaction = new Reaction(`render.${name}.${this.constructOrder}`, () => {
            super.forceUpdate();
        });

        componentWillUnmount() {
            this.reaction.dispose();
            super.componentWillUnmount?.();
        }

        render() {
            let output: preact.ComponentChild;
            this.reaction.track(() => {
                output = super.render();
            });
            return output;
        }
    };
}