import * as fs from "fs";
import * as path from "path";
import { listPortMappings } from "./src/forwardPort";


async function main() {
    let mappings = await listPortMappings();
    console.log(`Found ${mappings.length} port mapping(s):`);
    for (let mapping of mappings) {
        let host = mapping.remoteHost || "*";
        let lease = mapping.leaseDuration === 0 ? "permanent" : `${mapping.leaseDuration}s left`;
        console.log(`  ${mapping.protocol} ${host}:${mapping.externalPort} -> ${mapping.internalClient}:${mapping.internalPort} (${mapping.enabled ? "enabled" : "disabled"}, ${lease})${mapping.description ? ` "${mapping.description}"` : ""}`);
    }
    console.table(mappings);
}

main().catch(e => console.error(e)).finally(() => process.exit(0));
