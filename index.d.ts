/// <reference path="../typenode/index.d.ts" />

declare global {
    namespace NodeJS {
        interface Module {
            original: SerializedModule;
        }
    }
}

interface SerializedModule {
    originalId: string;
    filename: string;
    // If a module is not allowed clientside it is likely requests will be empty,
    //  to save effort parsing requests for modules that only exist to give better
    //  error messages.
    requests: {
        // request => resolvedPath
        [request: string]: string;
    };
    asyncRequests: { [request: string]: true };
    // NOTE: IF !allowclient && !serveronly, it might just mean we didn't add allowclient
    //  to the module yet. BUT, if serveronly, then we know for sure we don't want it client.
    //  So the messages and behavior will be different.
    allowclient?: boolean;
    serveronly?: boolean;
    // Just for errors mostly
    alwayssend?: boolean;

    /** Only set if allowclient. */
    source?: string;

    seqNum: number;

    size?: number;
    version?: number;

    flags?: {
        [flag: string]: true;
    };
}