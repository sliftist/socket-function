import { observable } from "mobx";
import { isNode } from "../src/misc";

// TODO: Batch url state changes
// TODO: Create actual links, that a tag can use
//  - Then after that, support not reloading the page, instead just setting the observables,
//      for faster navigation.

export class UrlParam<T> {
    constructor(private key: string, private defaultValue: T) { }
    valueSeqNum = observable({ value: 1 });
    public get(): T {
        urlBackSeqNum.value;
        this.valueSeqNum.value;
        let value = new URL(location.href).searchParams.get(this.key);
        if (value === null) {
            return this.defaultValue;
        }
        return JSON.parse(value) as T;
    }
    public set(value: T) {
        let url = new URL(location.href);
        url.searchParams.set(this.key, JSON.stringify(value));
        history.pushState({}, "", url.toString());
        this.valueSeqNum.value++;
    }
    public reset() {
        let url = new URL(location.href);
        url.searchParams.delete(this.key);
        history.pushState({}, "", url.toString());
        this.valueSeqNum.value++;
    }

    public get value() {
        return this.get();
    }
    public set value(value: T) {
        this.set(value);
    }
}

let urlBackSeqNum = observable({ value: 1 });
if (!isNode()) {
    window.addEventListener("popstate", () => {
        urlBackSeqNum.value++;
    });
}