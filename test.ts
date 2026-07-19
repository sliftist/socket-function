import { forwardPort, listPortMappings, resolveGateway, createPortMapping, deletePortMapping, PortMapping } from "./src/forwardPort";

// Verifies noPortStealing:
//   1. Against a real foreign mapping (owned by another device, if the router has one): forwardPort
//      must return { owned:false, reason:"declined" } and leave that mapping UNTOUCHED.
//   2. On a free port: noPortStealing still claims it (owned:true).
//   3. When the existing mapping is OURS: noPortStealing still (re)claims it (owned:true).
//   4. Default (stealing) still takes over an existing finite mapping and makes it permanent.

const TEST_EXTERNAL_PORT = 54000;
const TEST_INTERNAL_PORT = 54000;

async function main() {
    let { internalIP, gatewayIP, controlPort, controlURLs } = await resolveGateway();
    console.log(`Our IP: ${internalIP}`);

    async function mappingFor(externalPort: number): Promise<PortMapping | undefined> {
        return (await listPortMappings()).find(m => m.externalPort === externalPort && m.protocol.toUpperCase() === "TCP");
    }
    async function cleanup() {
        for (let controlPath of controlURLs) {
            await deletePortMapping({ externalPort: TEST_EXTERNAL_PORT, gatewayIP, controlPort, controlPath }).catch(() => { });
        }
    }
    let pass = true;
    let check = (ok: boolean, msg: string) => { if (!ok) pass = false; console.log(`  ${ok ? "PASS" : "FAIL"}: ${msg}`); };

    // 1. Real foreign mapping, if the router has one.
    console.log(`\n=== 1) decline a real foreign mapping (noPortStealing) ===`);
    let foreign = (await listPortMappings()).find(m => m.protocol.toUpperCase() === "TCP" && m.internalClient && m.internalClient !== internalIP);
    if (!foreign) {
        console.log(`  (skipped: router has no mapping owned by another device to test against)`);
    } else {
        console.log(`  found foreign mapping: port ${foreign.externalPort} -> ${foreign.internalClient} (lease ${foreign.leaseDuration}s)`);
        let result = await forwardPort({ externalPort: foreign.externalPort, internalPort: foreign.internalPort, noPortStealing: true });
        let after = await mappingFor(foreign.externalPort);
        check(!result.owned && result.reason === "declined", `forwardPort returned declined (got owned=${result.owned}, reason=${result.reason})`);
        check(after?.internalClient === foreign.internalClient && after?.leaseDuration === foreign.leaseDuration, `foreign mapping left untouched (still -> ${after?.internalClient}, lease ${after?.leaseDuration}s)`);
    }

    // 2. Free port: noPortStealing still claims.
    console.log(`\n=== 2) claim a free port (noPortStealing) ===`);
    await cleanup();
    let r2 = await forwardPort({ externalPort: TEST_EXTERNAL_PORT, internalPort: TEST_INTERNAL_PORT, noPortStealing: true });
    let m2 = await mappingFor(TEST_EXTERNAL_PORT);
    check(r2.owned === true, `returned owned=true (got ${r2.owned}, reason=${r2.reason})`);
    check(m2?.internalClient === internalIP && m2?.leaseDuration === 0, `mapping is ours & permanent (-> ${m2?.internalClient}, lease ${m2?.leaseDuration}s)`);

    // 3. Existing mapping is OURS: noPortStealing still reclaims.
    console.log(`\n=== 3) reclaim our own mapping (noPortStealing) ===`);
    let r3 = await forwardPort({ externalPort: TEST_EXTERNAL_PORT, internalPort: TEST_INTERNAL_PORT, noPortStealing: true });
    check(r3.owned === true, `returned owned=true (got ${r3.owned}, reason=${r3.reason})`);

    // 4. Default (stealing) takes over a finite mapping -> permanent.
    console.log(`\n=== 4) default takeover of a finite mapping ===`);
    await cleanup();
    for (let controlPath of controlURLs) {
        try {
            await createPortMapping({ externalPort: TEST_EXTERNAL_PORT, internalPort: TEST_INTERNAL_PORT, gatewayIP, controlPort, controlPath, internalIP, duration: 120 * 1000 });
            break;
        } catch { }
    }
    let seeded = await mappingFor(TEST_EXTERNAL_PORT);
    let r4 = await forwardPort({ externalPort: TEST_EXTERNAL_PORT, internalPort: TEST_INTERNAL_PORT });
    let m4 = await mappingFor(TEST_EXTERNAL_PORT);
    check(seeded?.leaseDuration === 120, `seeded a finite (120s) mapping first (got ${seeded?.leaseDuration}s)`);
    check(r4.owned === true && m4?.leaseDuration === 0, `took over -> permanent (owned=${r4.owned}, lease ${m4?.leaseDuration}s)`);

    await cleanup();
    console.log(`\n${pass ? "ALL PASS" : "SOME FAILED"}. Cleaned up test mapping on port ${TEST_EXTERNAL_PORT}.`);
}

main().catch(e => console.error(e.stack ?? e)).finally(() => process.exit(0));
