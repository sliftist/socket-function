/// <reference path="./RequireController.ts" />
module.allowclient = true;

/**
 *      Adds a global function setFlag(require, "typescript", flag) which sets a flag on the client
 *          - Ex, setFlag(require, "typescript", "allowclient") so allowclient = true on the typescript module.
 *          - Passing true as the fourth argument sets it recursively
 */

// We need at least 1 export, to force this to be treated like a module
export const forceModule = true;

declare global {
    function setFlag(require: NodeRequire, request: string, flag: string, recursive?: boolean): void;
}

function setRecursive(bangPart: string, module: NodeJS.Module) {
    let m = module as any;
    m.recursiveBangs = m.recursiveBangs || {};

    if (m.recursiveBangs[bangPart]) return;

    m.recursiveBangs[bangPart] = true;

    Object.assign(module, { [bangPart]: true });
    for (let child of module.children) {
        setRecursive(bangPart, child);
    }
}

const g = new Function("return this")();
g.setFlag = setFlag;
export function setFlag(require: NodeRequire, request: string, flag: string, recursive?: boolean) {
    let resolvedPath = require.resolve(request);
    let module = require.cache[resolvedPath] as any;
    if (!module) {
        console.warn(`setFlag cannot resolve module ${request}`);
        return;
    }
    if (recursive) {
        setRecursive(flag, module);
    } else {
        module[flag] = true;
    }
}