import child_process from "child_process";
import path from "path";
import { blue, red } from "./formatting/logColors";

export const runAsync = runPromise;
export async function runPromise(command: string, config?: {
    cwd?: string;
    quiet?: boolean;
    // Never throw, just return the full output
    nothrow?: boolean;
    detach?: boolean;
}) {
    return new Promise<string>((resolve, reject) => {
        if (!config?.quiet) {
            console.log(">" + blue(command));
        }
        const childProc = child_process.spawn(command, {
            shell: true,
            cwd: config?.cwd,
            stdio: ["inherit", "pipe", "pipe"],
            detached: config?.detach,
        });

        let fullOutput = "";
        let stderr = "";

        // Always collect output
        childProc.stdout?.on("data", (data) => {
            const chunk = data.toString();
            fullOutput += chunk;

            // Stream to console unless quiet mode
            if (!config?.quiet) {
                process.stdout.write(chunk);
            }
        });

        childProc.stderr?.on("data", (data) => {
            const chunk = data.toString();
            stderr += chunk;
            fullOutput += chunk;

            // Stream to console unless quiet mode
            if (!config?.quiet) {
                process.stderr.write(red(chunk));
            }
        });

        childProc.on("error", (err) => {
            if (config?.nothrow) {
                resolve(fullOutput);
            } else {
                reject(err);
            }
        });

        childProc.on("close", (code) => {
            if (code === 0 || config?.nothrow) {
                resolve(fullOutput);
            } else {
                let errorMessage = `Process exited with code ${code} for command: ${command}`;
                if (stderr) {
                    errorMessage += `\n${stderr}`;
                }
                const error = new Error(errorMessage);
                reject(error);
            }
        });
    });
}
