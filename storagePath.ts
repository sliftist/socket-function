import os from "os";
import fs from "fs";
import { lazy } from "./caching";

export const getAppFolder = lazy(() => {    
    const path = os.homedir() + "/socket-function/";
    if(!fs.existsSync(path)) {
        fs.mkdirSync(path);
    }
    return path;
});