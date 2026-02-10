/// <reference path="../../typenode/index.d.ts" />
/// <reference types="node" />
/// <reference types="node" />
declare global {
    namespace NodeJS {
        interface Module {
            /** Indicates the module is allowed clientside.
             *  NOTE: Set with `module.allowclient = true`. HOWEVER, access via getIsAllowClient, which will check
             */
            allowclient?: boolean;
            /** Causes the module to not preload, requiring `await import()` for it to load correctly
             *      - Shouldn't be set recursively, otherwise nested packages will break.
             */
            lazyload?: boolean;
            /** Indicates the module is definitely not allowed clientside */
            serveronly?: boolean;
            /** Used internally by RequireController */
            requireControllerSeqNum?: number;
            evalStartTime?: number;
            evalEndTime?: number;
            /** (Presently only called by require.js)
             *      Called on require calls, to allow providers to create custom exports depending on the caller.
             *          - Mostly used to allow functions to know the calling module.
             */
            remapExports?: (exports: {
                [key: string]: unknown;
            }, callerModule: NodeJS.Module) => {
                [key: string]: unknown;
            };
            /** Only set if clientside (and allowed clientside) */
            source?: string;
        }
    }
    interface Window {
        clientsideBootTime: number;
    }
    var suppressUnexpectedModuleWarning: number | undefined;
}
/** Imports it, serverside, delayed. For dynamic imports, which we need to include once, but don't want to include
 *      immediately (due to cyclic issues), and isn't included initially.
 */
export declare function lazyImport(getModule: () => Promise<unknown>): void;
declare const requireSeqNumProcessId: string;
declare function injectHTMLBeforeStartup(text: string | (() => Promise<string>)): void;
declare function addStaticRoot(root: string): void;
type GetModulesResult = ReturnType<RequireControllerBase["getModules"]> extends Promise<infer T> ? T : never;
export type GetModulesArgs = Parameters<RequireControllerBase["getModules"]>;
declare let mapGetModules: {
    remap(result: GetModulesResult, args: GetModulesArgs): Promise<GetModulesResult>;
}[];
declare function addMapGetModules(remap: typeof mapGetModules[number]["remap"]): void;
declare class RequireControllerBase {
    rootResolvePath: string;
    requireHTML(config?: {
        requireCalls?: string[];
        cacheTime?: number;
    }): Promise<Buffer>;
    getModules(pathRequests: string[], alreadyHave?: {
        requireSeqNumProcessId: string;
        seqNumRanges: {
            s: number;
            e?: number;
        }[];
    }, config?: {}): Promise<{
        requestsResolvedPaths: string[];
        modules: {
            [resolvedPath: string]: SerializedModule;
        };
        requireSeqNumProcessId: string;
    }>;
}
export declare function getIsAllowClient(module: NodeJS.Module): boolean | undefined;
type ClientRemapCallback = (args: GetModulesArgs) => Promise<GetModulesArgs>;
declare global {
    /** Must be set clientside BEFORE requests are made (so you likely want to use RequireController.addMapGetModules
     *      to inject code that will use this) */
    var remapImportRequestsClientside: undefined | ClientRemapCallback[];
}
/** @deprecated, not needed, as this defaults to ".", which is a lot easier to reason about anyways. */
export declare function setRequireBootRequire(dir: string): void;
export declare function allowAllNodeModules(): void;
export declare const RequireController: import("../SocketFunctionTypes").SocketRegistered<{
    rootResolvePath: "Function has implementation but is not exposed in the SocketFunction.register call";
    requireHTML: (config?: {
        requireCalls?: string[];
        cacheTime?: number;
    }) => Promise<Buffer>;
    getModules: (pathRequests: string[], alreadyHave?: {
        requireSeqNumProcessId: string;
        seqNumRanges: {
            s: number;
            e?: number;
        }[];
    }, config?: {}) => Promise<{
        requestsResolvedPaths: string[];
        modules: {
            [resolvedPath: string]: SerializedModule;
        };
        requireSeqNumProcessId: string;
    }>;
}> & {
    injectHTMLBeforeStartup: typeof injectHTMLBeforeStartup;
    addMapGetModules: typeof addMapGetModules;
    addStaticRoot: typeof addStaticRoot;
    allowAllNodeModules: typeof allowAllNodeModules;
};
export {};
