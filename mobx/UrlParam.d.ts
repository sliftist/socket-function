export declare class UrlParam<T> {
    private key;
    private defaultValue;
    constructor(key: string, defaultValue: T);
    valueSeqNum: {
        value: number;
    };
    get(): T;
    set(value: T): void;
    reset(): void;
    get value(): T;
    set value(value: T);
}
