export declare const runAsync: typeof runPromise;
export declare function runPromise(command: string, config?: {
    cwd?: string;
    quiet?: boolean;
    nothrow?: boolean;
    detach?: boolean;
}): Promise<string>;
