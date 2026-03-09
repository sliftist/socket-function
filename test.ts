import { getTimeComponentsDetailed, waitForFirstTimeSync } from "./time/trueTimeShim";
import * as fs from "fs";
import * as path from "path";

const SAMPLE_COUNT = 1000;
const SAMPLE_INTERVAL_MS = 10;

// Generate a simple numeric ID for this test run
const TEST_RUN_ID = Math.floor(Math.random() * 10000);

async function sampleMode() {
    await waitForFirstTimeSync();

    type Sample = {
        id: number;
        systemTime: number;
        offset: number;
        fromOffset: number;
        toOffset: number;
        fromTime: number;
        toTime: number;
        fraction: number;
    };

    const samples: Sample[] = [];

    console.log(`[Test ID: ${TEST_RUN_ID}] Sampling ${SAMPLE_COUNT} time components...`);
    for (let i = 0; i < SAMPLE_COUNT; i++) {
        const detailed = getTimeComponentsDetailed();

        // Calculate smearing using the same systemTime
        const elapsed = detailed.systemTime - detailed.fromTime;
        const duration = detailed.toTime - detailed.fromTime;
        const fraction = duration > 0 ? Math.min(1, elapsed / duration) : 0;
        const offset = detailed.fromOffset + (detailed.toOffset - detailed.fromOffset) * fraction;

        samples.push({
            id: TEST_RUN_ID,
            systemTime: detailed.systemTime,
            offset,
            fromOffset: detailed.fromOffset,
            toOffset: detailed.toOffset,
            fromTime: detailed.fromTime,
            toTime: detailed.toTime,
            fraction,
        });

        if (SAMPLE_INTERVAL_MS > 0) {
            await new Promise(resolve => setTimeout(resolve, SAMPLE_INTERVAL_MS));
        }
    }

    // Write to file with unique name
    const distDir = path.join(__dirname, "dist");
    if (!fs.existsSync(distDir)) {
        fs.mkdirSync(distDir, { recursive: true });
    }

    const filename = path.join(distDir, `time-samples-${Date.now()}-${process.pid}.json`);
    fs.writeFileSync(filename, JSON.stringify(samples, null, 2));

    console.log(`[Test ID: ${TEST_RUN_ID}] Wrote ${samples.length} samples to ${filename}`);
}

async function verifyMode() {
    const distDir = path.join(__dirname, "dist");
    if (!fs.existsSync(distDir)) {
        console.error("No dist directory found. Run sampling mode first.");
        process.exit(1);
    }

    const files = fs.readdirSync(distDir)
        .filter(f => f.startsWith("time-samples-") && f.endsWith(".json"))
        .map(f => path.join(distDir, f));

    if (files.length === 0) {
        console.error("No sample files found. Run sampling mode first.");
        process.exit(1);
    }

    console.log(`Found ${files.length} sample files`);

    type Sample = {
        id: number;
        systemTime: number;
        offset: number;
        fromOffset: number;
        toOffset: number;
        fromTime: number;
        toTime: number;
        fraction: number;
        file: string;
    };

    // Load all samples from all files
    const allSamples: Sample[] = [];

    for (const file of files) {
        const content = fs.readFileSync(file, "utf-8");
        const samples = JSON.parse(content);
        for (const sample of samples) {
            allSamples.push({ ...sample, file: path.basename(file) });
        }
    }

    console.log(`Loaded ${allSamples.length} total samples`);

    // Sort by systemTime
    allSamples.sort((a, b) => a.systemTime - b.systemTime);

    // Verify that systemTime + offset is monotonically increasing
    let errors = 0;
    let lastTrueTime = -Infinity;

    for (let i = 0; i < allSamples.length; i++) {
        const sample = allSamples[i];
        const trueTime = sample.systemTime + sample.offset;

        if (trueTime < lastTrueTime) {
            errors++;
            const prev = allSamples[i - 1];
            const prevTrueTime = prev.systemTime + prev.offset;

            console.error(`\nERROR at index ${i}: trueTime went backwards!`);
            console.error(`  Previous [ID: ${prev.id}, file: ${prev.file}]:`);
            console.error(`    systemTime: ${prev.systemTime}`);
            console.error(`    offset: ${prev.offset}`);
            console.error(`    trueTime: ${prevTrueTime}`);
            console.error(`    smearing: ${prev.fromOffset} -> ${prev.toOffset} (${(prev.fraction * 100).toFixed(2)}%)`);
            console.error(`    timeWindow: ${prev.fromTime} -> ${prev.toTime}`);
            console.error(`  Current [ID: ${sample.id}, file: ${sample.file}]:`);
            console.error(`    systemTime: ${sample.systemTime}`);
            console.error(`    offset: ${sample.offset}`);
            console.error(`    trueTime: ${trueTime}`);
            console.error(`    smearing: ${sample.fromOffset} -> ${sample.toOffset} (${(sample.fraction * 100).toFixed(2)}%)`);
            console.error(`    timeWindow: ${sample.fromTime} -> ${sample.toTime}`);
            console.error(`  Difference: ${trueTime - lastTrueTime}ms`);
        }

        lastTrueTime = trueTime;
    }

    if (errors === 0) {
        console.log(`✓ SUCCESS: All ${allSamples.length} samples are correctly ordered!`);
        console.log(`  Time range: ${allSamples[0].systemTime} to ${allSamples[allSamples.length - 1].systemTime}`);
        console.log(`  Duration: ${allSamples[allSamples.length - 1].systemTime - allSamples[0].systemTime}ms`);
    } else {
        console.error(`✗ FAILED: Found ${errors} ordering violations`);
        process.exit(1);
    }
}

async function main() {
    const mode = process.argv[2];

    if (mode === "once") {
        await waitForFirstTimeSync();
        console.log(Date.now());
    }
    else if (mode === "verify") {
        await verifyMode();
    } else {
        await sampleMode();
    }
}

main().catch(e => console.error(e)).finally(() => process.exit(0));