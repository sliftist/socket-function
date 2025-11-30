export declare const testTCPIsListening: (host: string, port: number) => Promise<boolean>;
export declare const getExternalIP: {
    (): Promise<string>;
    reset(): void;
    set(newValue: Promise<string>): void;
};
export declare const getPublicIP: {
    (): Promise<string>;
    reset(): void;
    set(newValue: Promise<string>): void;
};
