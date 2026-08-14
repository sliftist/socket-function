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

// Yarn itself spells this "--dry-run", so accept that plus every spelling anyone reasonably reaches for.
const DRY_RUN_FLAGS = ["--dry", "-dry", "--dryrun", "-dryrun", "--dry-run", "-dry-run", "--dry_run", "-dry_run"];

// yarn install can still decide to re-resolve and re-split; re-running the merge converges in that case.
const MAX_MERGE_PASSES = 3;

// yarn v1 rewrites npm registry urls to its own mirror, so entries we synthesize have to match or yarn
//  churns the lockfile back on the next install.
const NPM_REGISTRY_HOST = "registry.npmjs.org";
const YARN_REGISTRY_HOST = "registry.yarnpkg.com";

async function main() {
    let args = process.argv.slice(2);
    let packageName = args.find(arg => !arg.startsWith("-"));
    let dryRun = args.some(arg => DRY_RUN_FLAGS.includes(arg.toLowerCase()));
    if (!packageName) {
        console.error("Usage: yarn upreal <package-name> [--dry-run]");
        process.exit(1);
        return;
    }

    let projectRoot = process.cwd();
    let packageJsonPath = path.join(projectRoot, "package.json");
    let lockPath = path.join(projectRoot, "yarn.lock");

    let manifest = await getLatestManifest(packageName);
    console.log(`Latest version of ${packageName}: ${manifest.version}`);

    let newRange = updatePackageJson(packageJsonPath, packageName, manifest.version);

    for (let pass = 1; pass <= MAX_MERGE_PASSES; pass++) {
        if (fs.existsSync(lockPath)) {
            let result = mergeLockEntries(lockPath, packageName, manifest, newRange);
            console.log(`Lockfile pass ${pass}: ${result.specs.length} spec${result.specs.length === 1 ? "" : "s"} for ${packageName} now share one entry at ${manifest.version}: ${result.specs.join(", ")}`);
            for (let moved of result.movedFrom) {
                console.log(`  ${moved.spec} was resolving to ${moved.version}`);
            }
            for (let left of result.leftAlone) {
                console.log(`  left ${left} alone (not a registry range, so it can't point at a version)`);
            }
        }

        if (dryRun) {
            console.log(`Dry run: package.json and yarn.lock are rewritten, skipping yarn install.`);
            return;
        }

        console.log(`Running yarn install...`);
        await runYarnInstall(projectRoot);

        let versions = getLockedVersions(lockPath, packageName);
        if (versions.length <= 1) {
            console.log(`Done. ${packageName} resolves to a single version: ${versions[0] ?? manifest.version}`);
            return;
        }
        console.log(`${packageName} still resolves to ${versions.length} versions (${versions.join(", ")}); merging again.`);
    }

    let versions = getLockedVersions(lockPath, packageName);
    console.error(`Failed to collapse ${packageName} onto one version after ${MAX_MERGE_PASSES} passes; still at ${versions.join(", ")}`);
    process.exit(1);
}

// Point every package.json section that mentions the package at the latest version, keeping each section's
//  existing range operator, and return the range the lockfile entry has to satisfy.
function updatePackageJson(packageJsonPath: string, packageName: string, latest: string): string {
    let raw = fs.readFileSync(packageJsonPath, "utf8");
    let packageJson = JSON.parse(raw) as {
        [section: string]: { [name: string]: string } | undefined;
    };

    let newRange: string | undefined;
    for (let section of DEP_SECTIONS) {
        let deps = packageJson[section];
        if (!deps || !(packageName in deps)) {
            continue;
        }
        let currentRange = deps[packageName];
        let sectionRange = applyPrefix(currentRange, latest);
        newRange = newRange ?? sectionRange;
        if (sectionRange === currentRange) {
            console.log(`package.json ${section}.${packageName} already ${currentRange}`);
            continue;
        }
        raw = replaceRange(raw, packageName, currentRange, sectionRange);
        fs.writeFileSync(packageJsonPath, raw);
        console.log(`Updated package.json ${section}.${packageName}: ${currentRange} -> ${sectionRange}`);
    }

    if (newRange === undefined) {
        console.log(`${packageName} is not a direct dependency; only merging the transitive references.`);
        return "^" + latest;
    }
    return newRange;
}

interface Manifest {
    version: string;
    dist?: { tarball?: string; shasum?: string; integrity?: string };
    dependencies?: { [name: string]: string };
    optionalDependencies?: { [name: string]: string };
}

async function getLatestManifest(packageName: string): Promise<Manifest> {
    // Scoped names ("@scope/name") must have their slash encoded in the registry path.
    let encodedName = packageName.startsWith("@")
        ? "@" + encodeURIComponent(packageName.slice(1))
        : encodeURIComponent(packageName);
    let url = `https://${NPM_REGISTRY_HOST}/${encodedName}/latest`;

    // Via httpsRequest so registry lookups go through the DNS cache (and its re-resolve/retry), rather
    //  than getaddrinfo, which caches certain failures forever.
    let body = (await httpsRequest(url)).toString("utf8");

    let parsed = JSON.parse(body) as Manifest;
    if (!parsed.version) {
        throw new Error(`Registry response for ${packageName} had no version field`);
    }
    return parsed;
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

interface LockBlock {
    // Index of the header line, and the exclusive end of the block (trailing blank lines included).
    start: number;
    end: number;
    specs: string[];
}

interface LockFile {
    lines: string[];
    eol: string;
    blocks: LockBlock[];
}

function readLock(lockPath: string): LockFile {
    let raw = fs.readFileSync(lockPath, "utf8");
    let eol = raw.includes("\r\n") ? "\r\n" : "\n";
    let lines = raw.split(/\r?\n/);

    let blocks: LockBlock[] = [];
    let current: LockBlock | undefined;
    for (let i = 0; i < lines.length; i++) {
        if (!isBlockHeader(lines[i])) {
            continue;
        }
        if (current) {
            current.end = i;
        }
        current = { start: i, end: lines.length, specs: parseHeaderSpecs(lines[i]) };
        blocks.push(current);
    }
    return { lines, eol, blocks };
}

function isBlockHeader(line: string): boolean {
    if (!line || line.startsWith("#") || /^\s/.test(line)) {
        return false;
    }
    return line.trimEnd().endsWith(":");
}

function parseHeaderSpecs(headerLine: string): string[] {
    // e.g. `"pkg@^1.0.0", "pkg@~1.2.0":` -> ["pkg@^1.0.0", "pkg@~1.2.0"]
    let specsPart = headerLine.trimEnd().replace(/:$/, "");
    return specsPart.split(",").map(spec => spec.trim().replace(/^"|"$/g, ""));
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

function specRange(spec: string): string {
    return spec.slice(specNamePackage(spec).length + 1);
}

// Ranges that don't come from the registry (git urls, file:, link:, npm: aliases) can't be pointed at a
//  version number, so their entry has to stay separate.
function isRegistryRange(range: string): boolean {
    return !range.includes(":") && !range.includes("/");
}

// yarn.lock quotes a token only when it would otherwise be ambiguous, and rewriting a token with different
//  quoting than yarn would use makes every later install churn the file.
function quoteToken(value: string): string {
    let needsQuotes = /[:\s\n\\",[\]]/.test(value) || !/^[a-zA-Z]/.test(value);
    return needsQuotes ? `"${value}"` : value;
}

function formatHeader(specs: string[]): string {
    return specs.map(quoteToken).join(", ") + ":";
}

// Put every registry spec for the package onto ONE entry resolving to the latest version. Nothing is deleted:
//  a spec that asked for an old version (`pkg@1.2.3`) stays in the header and now points at the new version,
//  which is what stops yarn from re-creating a second entry the next time something re-resolves.
function mergeLockEntries(lockPath: string, packageName: string, manifest: Manifest, newRange: string): {
    specs: string[];
    movedFrom: { spec: string; version: string }[];
    leftAlone: string[];
} {
    let lock = readLock(lockPath);
    let specs = new Set<string>([`${packageName}@${newRange}`]);
    let movedFrom: { spec: string; version: string }[] = [];
    let leftAlone: string[] = [];
    let removeLines = new Set<number>();
    let insertAt: number | undefined;
    let body: string[] | undefined;

    for (let block of lock.blocks) {
        if (!block.specs.some(spec => specNamePackage(spec) === packageName)) {
            continue;
        }
        let mergeable = block.specs.filter(spec => specNamePackage(spec) === packageName && isRegistryRange(specRange(spec)));
        let keep = block.specs.filter(spec => !mergeable.includes(spec));
        if (mergeable.length === 0) {
            leftAlone.push(...block.specs);
            continue;
        }

        let version = getBlockVersion(lock, block);
        for (let spec of mergeable) {
            if (!specs.has(spec) && version !== manifest.version) {
                movedFrom.push({ spec, version: version ?? "?" });
            }
            specs.add(spec);
        }
        // Reuse the real entry when the lockfile already holds the latest version, so we keep yarn's own
        //  resolved url and integrity hash rather than synthesizing them.
        if (version === manifest.version && !body) {
            body = lock.lines.slice(block.start + 1, blockBodyEnd(lock, block));
        }
        if (keep.length > 0) {
            lock.lines[block.start] = formatHeader(keep);
            leftAlone.push(...keep);
            continue;
        }
        insertAt = insertAt ?? block.start;
        for (let i = block.start; i < block.end; i++) {
            removeLines.add(i);
        }
    }

    let merged = [formatHeader(Array.from(specs).sort()), ...(body ?? synthesizeBody(manifest)), ""];

    let output: string[] = [];
    for (let i = 0; i < lock.lines.length; i++) {
        if (i === insertAt) {
            output.push(...merged);
        }
        if (removeLines.has(i)) {
            continue;
        }
        output.push(lock.lines[i]);
    }
    if (insertAt === undefined) {
        // The package wasn't in the lockfile at all; append and let yarn sort it.
        output.push(...merged);
    }

    fs.writeFileSync(lockPath, output.join(lock.eol));
    return { specs: Array.from(specs).sort(), movedFrom, leftAlone };
}

// The lines a block owns, excluding the blank line(s) separating it from the next block.
function blockBodyEnd(lock: LockFile, block: LockBlock): number {
    let end = block.end;
    while (end > block.start + 1 && lock.lines[end - 1].trim() === "") {
        end--;
    }
    return end;
}

function getBlockVersion(lock: LockFile, block: LockBlock): string | undefined {
    for (let i = block.start + 1; i < block.end; i++) {
        let match = /^\s+version "(.*)"$/.exec(lock.lines[i]);
        if (match) {
            return match[1];
        }
    }
    return undefined;
}

// Build a lockfile entry for a version the lockfile has never seen, from the registry's own metadata.
function synthesizeBody(manifest: Manifest): string[] {
    let tarball = manifest.dist?.tarball;
    if (!tarball) {
        throw new Error(`Registry response for ${manifest.version} had no dist.tarball, so no lockfile entry can be written`);
    }
    let resolved = tarball.replace(NPM_REGISTRY_HOST, YARN_REGISTRY_HOST);
    if (manifest.dist?.shasum) {
        resolved += "#" + manifest.dist.shasum;
    }

    let lines = [`  version ${quoteToken(manifest.version)}`, `  resolved ${quoteToken(resolved)}`];
    if (manifest.dist?.integrity) {
        lines.push(`  integrity ${quoteToken(manifest.dist.integrity)}`);
    }
    for (let section of ["dependencies", "optionalDependencies"] as const) {
        let deps = manifest[section];
        if (!deps || Object.keys(deps).length === 0) {
            continue;
        }
        lines.push(`  ${section}:`);
        for (let name of Object.keys(deps).sort()) {
            lines.push(`    ${quoteToken(name)} ${quoteToken(deps[name])}`);
        }
    }
    return lines;
}

function getLockedVersions(lockPath: string, packageName: string): string[] {
    if (!fs.existsSync(lockPath)) {
        return [];
    }
    let lock = readLock(lockPath);
    let versions = new Set<string>();
    for (let block of lock.blocks) {
        if (!block.specs.some(spec => specNamePackage(spec) === packageName)) {
            continue;
        }
        let version = getBlockVersion(lock, block);
        if (version) {
            versions.add(version);
        }
    }
    return Array.from(versions);
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
