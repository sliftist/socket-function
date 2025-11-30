/// <reference path="RequireController.d.ts" />
/// <reference types="node" />
/**
 *      Adds a global function setFlag(require, "typescript", flag) which sets a flag on the client
 *          - Ex, setFlag(require, "typescript", "allowclient") so allowclient = true on the typescript module.
 *          - Passing true as the fourth argument sets it recursively
 */
export declare const forceModule = true;
declare global {
}
export declare function setFlag(require: NodeRequire, request: string, flag: string, recursive?: boolean): void;
