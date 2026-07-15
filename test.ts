import { listPortMappings, getLocalInternalIP, isBehindNAT } from "./src/forwardPort";


async function main() {
    let ourIP = await getLocalInternalIP();
    let behindNAT = await isBehindNAT();
    console.log(`Outbound / local IP: ${ourIP ?? "(could not determine)"}`);
    console.log(`Behind NAT (forwarding ${behindNAT ? "WILL" : "will NOT"} be attempted): ${behindNAT}`);

    let mappings = await listPortMappings();
    console.log(`Found ${mappings.length} port mapping(s):`);
    for (let mapping of mappings) {
        let host = mapping.remoteHost || "*";
        let lease = mapping.leaseDuration === 0 ? "permanent" : `${mapping.leaseDuration}s left`;
        let ours = ourIP && mapping.internalClient === ourIP ? " <-- OURS" : "";
        console.log(`  ${mapping.protocol} ${host}:${mapping.externalPort} -> ${mapping.internalClient}:${mapping.internalPort} (${mapping.enabled ? "enabled" : "disabled"}, ${lease})${mapping.description ? ` "${mapping.description}"` : ""}${ours}`);
    }
    console.table(mappings);
}

main().catch(e => console.error(e.stack ?? e)).finally(() => process.exit(0));
