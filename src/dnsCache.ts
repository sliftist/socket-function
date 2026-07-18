import * as dns from "dns";
import * as net from "net";
import { delay } from "./batching";

// Node's default `dns.lookup` (getaddrinfo) delegates to glibc on Linux, which caches certain
//  failures (notably EAI_AGAIN from a temporarily unreachable resolver) effectively forever within
//  the process. Once poisoned, every subsequent connection to that host keeps failing even after the
//  network recovers. To avoid this we resolve names ourselves via `dns.resolve*` (which talks to the
//  resolver directly and keeps no such sticky failure cache) and maintain our own cache that we can
//  invalidate on demand. httpsRequest drives that invalidation: on a connection-establishment error it
//  asks us to re-resolve, then retries against the fresh address.

// How long a successful resolution is trusted before we resolve again. Node by default does no positive
//  caching at all — it calls getaddrinfo for every single connection — so any cache we add is strictly
//  better than the baseline; even a 1s TTL would be an improvement. (The failure case is the exception:
//  glibc caches certain resolution failures process-forever, which is the whole reason this module exists.)
const CACHE_TTL = 60 * 1000;
// A single resolution keeps retrying for up to this long / this many attempts before giving up. We very
//  rarely hit genuinely invalid domains, so we happily trade latency for riding out flaky resolvers.
const RESOLVE_MAX_TRIES = 10;
const RESOLVE_MAX_DURATION = 5 * 1000;
const RESOLVE_RETRY_INTERVAL = 500;
// Minimum spacing between forced re-resolutions of the same host. This both protects the resolver from a
//  retry storm and defines when a re-resolution is pointless: if we re-resolved this recently, retrying
//  the request would just reuse the same fresh answer, so httpsRequest is told not to bother.
const RERESOLVE_THROTTLE = 5 * 1000;
// How long a failed resolution is remembered. Without this, a genuinely unresolvable host would re-run the
//  full (already-exhaustive) 5s resolve loop on every retry and every parallel caller — the resolve loop
//  takes as long as the throttle window, so the throttle alone never engages. A failure that just survived
//  RESOLVE_MAX_TRIES won't differ if we immediately try again, so we serve it from cache instead.
const NEGATIVE_CACHE_TTL = 5 * 1000;

interface DNSRecord {
    address: string;
    // 4 or 6
    family: number;
}

interface DNSEntry {
    hostname: string;
    records?: DNSRecord[];
    resolvedAt: number;
    // Shared by all callers that arrive while a resolution is in flight, so parallel requests to the
    //  same host block on a single resolution rather than each firing their own.
    resolving?: Promise<DNSRecord[]>;
    lastReresolve: number;
    // Negative cache: the last resolution failure and when it completed, so recent failures short-circuit
    //  rather than re-running the resolve loop. Kept as the real Error so we rethrow it with its code intact.
    lastError?: Error;
    failedAt?: number;
}

const entries = new Map<string, DNSEntry>();
function getEntry(hostname: string): DNSEntry {
    let entry = entries.get(hostname);
    if (!entry) {
        entry = { hostname, resolvedAt: 0, lastReresolve: 0 };
        entries.set(hostname, entry);
    }
    return entry;
}

function filterFamily(records: DNSRecord[], family: number): DNSRecord[] {
    if (!family) return records;
    return records.filter(r => r.family === family);
}

// Resolves both address families directly (ignoring the requested family so the cache is family-agnostic;
//  callers filter afterwards). Falls back to getaddrinfo for names dns.resolve can't see — IP literals,
//  localhost, and anything in /etc/hosts.
async function resolveOnce(hostname: string): Promise<DNSRecord[]> {
    let ipFamily = net.isIP(hostname);
    if (ipFamily) {
        return [{ address: hostname, family: ipFamily }];
    }

    let records: DNSRecord[] = [];
    await Promise.all([
        dns.promises.resolve4(hostname).then(
            addresses => { for (let address of addresses) records.push({ address, family: 4 }); },
            // A host having no A (or no AAAA) record is normal, not a failure of the whole resolution.
            () => { }
        ),
        dns.promises.resolve6(hostname).then(
            addresses => { for (let address of addresses) records.push({ address, family: 6 }); },
            () => { }
        ),
    ]);
    if (records.length > 0) {
        return records;
    }

    // dns.resolve* ignores /etc/hosts and the `localhost` entry, so fall back to getaddrinfo. We only
    //  reach the sticky-failure-caching path when our own resolution found nothing, which is exactly the
    //  case where /etc/hosts is the likely source of truth.
    let fallback = await dns.promises.lookup(hostname, { all: true });
    return fallback.map(r => ({ address: r.address, family: r.family }));
}

async function resolveFresh(hostname: string): Promise<DNSRecord[]> {
    let start = Date.now();
    let attempt = 0;
    let lastError: unknown;
    while (true) {
        attempt++;
        try {
            let records = await resolveOnce(hostname);
            if (records.length > 0) {
                return records;
            }
            lastError = new Error(`No DNS records found for ${hostname}`);
        } catch (e) {
            lastError = e;
        }
        if (attempt >= RESOLVE_MAX_TRIES) break;
        if (Date.now() - start >= RESOLVE_MAX_DURATION) break;
        await delay(RESOLVE_RETRY_INTERVAL);
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function startResolve(entry: DNSEntry): Promise<DNSRecord[]> {
    let resolving = (async () => {
        try {
            let records = await resolveFresh(entry.hostname);
            entry.records = records;
            entry.resolvedAt = Date.now();
            entry.lastError = undefined;
            entry.failedAt = undefined;
            return records;
        } catch (e) {
            entry.records = undefined;
            entry.lastError = e instanceof Error ? e : new Error(String(e));
            entry.failedAt = Date.now();
            throw entry.lastError;
        } finally {
            entry.resolving = undefined;
        }
    })();
    entry.resolving = resolving;
    return resolving;
}

export async function resolveHost(hostname: string, family = 0): Promise<DNSRecord[]> {
    let entry = getEntry(hostname);
    if (entry.records && Date.now() - entry.resolvedAt < CACHE_TTL) {
        return filterFamily(entry.records, family);
    }
    // Serve a recent failure from the negative cache rather than re-running the exhaustive resolve loop.
    if (entry.lastError && entry.failedAt !== undefined && Date.now() - entry.failedAt < NEGATIVE_CACHE_TTL) {
        throw entry.lastError;
    }
    let resolving = entry.resolving ?? startResolve(entry);
    return filterFamily(await resolving, family);
}

// A `lookup` function matching Node's net/http contract, so we can hand it to http(s).request and have
//  the socket use our cache instead of getaddrinfo. Always resolves via our cache; happy eyeballs
//  (autoSelectFamily) then races the returned addresses.
export const dnsCacheLookup: net.LookupFunction = function dnsCacheLookup(hostname, options, callback) {
    let rawFamily = typeof options === "number" ? options : options.family ?? 0;
    let family = rawFamily === "IPv4" ? 4 : rawFamily === "IPv6" ? 6 : rawFamily;
    let all = typeof options === "object" && options.all;
    resolveHost(hostname, family).then(
        records => {
            if (all) {
                callback(null, records.map(r => ({ address: r.address, family: r.family })));
            } else {
                let record = records[0];
                callback(null, record.address, record.family);
            }
        },
        (err: NodeJS.ErrnoException) => callback(err, "", undefined)
    );
};

// Called by httpsRequest when a connection could not be established. Forces a throttled re-resolution and
//  reports whether retrying is worthwhile. Returns false when we re-resolved too recently — in that case
//  the cache already holds the freshest answer we can get, so retrying would hit the same address.
export async function reportConnectionFailure(hostname: string): Promise<boolean> {
    let entry = getEntry(hostname);

    // Another failure already kicked off a re-resolution; block on it and then retry, so parallel
    //  failures for the same host share a single resolution.
    if (entry.resolving) {
        await entry.resolving.catch(() => { });
        return true;
    }

    // The resolver itself just failed exhaustively; re-resolving now would only reproduce that failure, so
    //  there's no point making httpsRequest wait and retry.
    if (entry.lastError && entry.failedAt !== undefined && Date.now() - entry.failedAt < NEGATIVE_CACHE_TTL) {
        return false;
    }

    if (Date.now() - entry.lastReresolve < RERESOLVE_THROTTLE) {
        return false;
    }
    entry.lastReresolve = Date.now();
    entry.records = undefined;
    await startResolve(entry).catch(() => { });
    return true;
}
