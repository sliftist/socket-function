import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { httpsRequest } from "./https";

// Dependency sections in package.json that upreal is willing to update, in the order we search them.
const DEP_SECTIONS = [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
] as const;

async function main() {
    let packageName = process.argv.slice(2).find(arg => !arg.startsWith("-"));
    if (!packageName) {
        console.error("Usage: yarn upreal <package-name>");
        process.exit(1);
        return;
    }

    let projectRoot = process.cwd();
    let packageJsonPath = path.join(projectRoot, "package.json");
    let lockPath = path.join(projectRoot, "yarn.lock");

    let packageJsonRaw = fs.readFileSync(packageJsonPath, "utf8");
    let packageJson = JSON.parse(packageJsonRaw) as {
        [section: string]: { [name: string]: string } | undefined;
    };

    let currentRange = findCurrentRange(packageJson, packageName);
    if (currentRange === undefined) {
        console.error(`Package "${packageName}" is not listed in ${DEP_SECTIONS.join(", ")} of package.json`);
        process.exit(1);
        return;
    }

    console.log(`Current range for ${packageName}: ${currentRange}`);

    let latest = await getLatestVersion(packageName);
    console.log(`Latest version of ${packageName}: ${latest}`);

    let newRange = applyPrefix(currentRange, latest);
    if (newRange === currentRange) {
        console.log(`package.json range unchanged (${currentRange}); will still re-resolve the lockfile.`);
    } else {
        packageJsonRaw = replaceRange(packageJsonRaw, packageName, currentRange, newRange);
        fs.writeFileSync(packageJsonPath, packageJsonRaw);
        console.log(`Updated package.json: ${packageName} ${currentRange} -> ${newRange}`);
    }

    // Drop every lockfile entry for this package so `yarn install` re-resolves each of its ranges (ours and any
    // transitive ones) to the newest version they can reach. This is what makes "everything that could be updated"
    // update in one shot, rather than yarn pinning the previously-locked versions.
    if (fs.existsSync(lockPath)) {
        let lockRaw = fs.readFileSync(lockPath, "utf8");
        let { lock, removed } = removeLockEntries(lockRaw, packageName);
        if (removed > 0) {
            fs.writeFileSync(lockPath, lock);
            console.log(`Removed ${removed} lockfile entr${removed === 1 ? "y" : "ies"} for ${packageName} so they re-resolve.`);
        }
    }

    console.log(`Running yarn install...`);
    await runYarnInstall(projectRoot);
    console.log(`Done. ${packageName} is now at ${newRange}.`);
}

function findCurrentRange(
    packageJson: { [section: string]: { [name: string]: string } | undefined },
    packageName: string
): string | undefined {
    for (let section of DEP_SECTIONS) {
        let deps = packageJson[section];
        if (deps && packageName in deps) {
            return deps[packageName];
        }
    }
    return undefined;
}

async function getLatestVersion(packageName: string): Promise<string> {
    // Scoped names ("@scope/name") must have their slash encoded in the registry path.
    let encodedName = packageName.startsWith("@")
        ? "@" + encodeURIComponent(packageName.slice(1))
        : encodeURIComponent(packageName);
    let url = `https://registry.npmjs.org/${encodedName}/latest`;

    // Via httpsRequest so registry lookups go through the DNS cache (and its re-resolve/retry), rather
    //  than getaddrinfo, which caches certain failures forever.
    let body = (await httpsRequest(url)).toString("utf8");

    let parsed = JSON.parse(body) as { version?: string };
    if (!parsed.version) {
        throw new Error(`Registry response for ${packageName} had no version field`);
    }
    return parsed.version;
}

// Keep whatever range operator the user already chose (^, ~, exact, or *) and point it at the new version.
function applyPrefix(currentRange: string, latest: string): string {
    if (currentRange === "*" || currentRange === "" || currentRange === "latest") {
        return currentRange;
    }
    if (currentRange.startsWith("^")) {
        return "^" + latest;
    }
    if (currentRange.startsWith("~")) {
        return "~" + latest;
    }
    return latest;
}

function replaceRange(packageJsonRaw: string, packageName: string, oldRange: string, newRange: string): string {
    // Rewrite the value in place (rather than JSON.stringify) so the file keeps its exact formatting and tab style.
    let keyPattern = new RegExp(`("${escapeRegExp(packageName)}"\\s*:\\s*")${escapeRegExp(oldRange)}(")`);
    if (!keyPattern.test(packageJsonRaw)) {
        throw new Error(`Could not locate "${packageName}": "${oldRange}" in package.json to update`);
    }
    return packageJsonRaw.replace(keyPattern, `$1${newRange}$2`);
}

// Remove all yarn.lock v1 blocks that resolve the given package (across every range variant of it).
function removeLockEntries(lockRaw: string, packageName: string): { lock: string; removed: number } {
    // yarn.lock v1 blocks are separated by blank lines; the first line of each block is the comma-separated
    // list of specs it satisfies, e.g. `"pkg@^1.0.0", "pkg@~1.2.0":`.
    let blocks = lockRaw.split(/\r?\n\r?\n/);
    let removed = 0;
    let kept: string[] = [];
    for (let block of blocks) {
        if (blockResolvesPackage(block, packageName)) {
            removed++;
            continue;
        }
        kept.push(block);
    }
    return { lock: kept.join("\n\n"), removed };
}

function blockResolvesPackage(block: string, packageName: string): boolean {
    let headerLine = block.split(/\r?\n/).find(line => line.trim().length > 0 && !line.startsWith("#"));
    if (!headerLine || !headerLine.trimEnd().endsWith(":")) {
        return false;
    }
    // Strip the trailing colon, then split on commas into individual quoted-or-bare specs.
    let specsPart = headerLine.trimEnd().replace(/:$/, "");
    let specs = specsPart.split(",").map(spec => spec.trim().replace(/^"|"$/g, ""));
    for (let spec of specs) {
        if (specNamePackage(spec) === packageName) {
            return true;
        }
    }
    return false;
}

// Extract the package name from a lock spec like `@scope/name@^1.0.0` or `name@~1.2.0`.
function specNamePackage(spec: string): string {
    let atIndex = spec.lastIndexOf("@");
    // A leading "@" (scoped package) is part of the name, not the name/range separator.
    if (atIndex <= 0) {
        return spec;
    }
    return spec.slice(0, atIndex);
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function runYarnInstall(cwd: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        // yarn is a .cmd shim on Windows, so it must be spawned through the shell.
        let child = spawn("yarn", ["install"], { cwd, stdio: "inherit", shell: true });
        child.on("error", reject);
        child.on("exit", code => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`yarn install exited with code ${code}`));
            }
        });
    });
}

main().catch(e => {
    console.error(e.stack ?? e);
    process.exit(1);
});
