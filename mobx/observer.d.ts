import type preact from "preact";
import { Reaction } from "mobx";
/** @deprecated Use the version from sliftutils instead. */ export declare function observer<T extends {
    new (...args: any[]): {
        render(): preact.ComponentChild;
        forceUpdate(callback?: () => void): void;
        componentWillUnmount?(): void;
    };
}>(Constructor: T): {
    new (...args: any[]): {
        constructOrder: number;
        reaction: Reaction;
        componentWillUnmount(): void;
        render(): preact.ComponentChild;
        forceUpdate(callback?: () => void): void;
    };
    readonly name: string;
} & T;
