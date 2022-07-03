import debugbreak from "debugbreak";
import { compileTransformBefore } from "typenode";

compileTransformBefore((contents: string, path: string, module: NodeJS.Module): string => {
    if (path.endsWith(".css")) {
        module.allowclient = true;
        function injectCSS(contents: string) {
            if (typeof document === "undefined") {
                return;
            }
            let style = document.createElement("style");
            style.innerHTML = contents;
            document.head.appendChild(style);
        }
        return `(${injectCSS.toString()})(${JSON.stringify(contents)})`;
    }
    return contents;
});
