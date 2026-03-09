const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Clean up old test files
console.log('Cleaning up old test files...');
const distDir = path.join(__dirname, 'dist');
if (fs.existsSync(distDir)) {
    const files = fs.readdirSync(distDir)
        .filter(f => f.startsWith('time-samples-') && f.endsWith('.json'));
    for (const file of files) {
        fs.unlinkSync(path.join(distDir, file));
    }
}

// Launch 4 concurrent processes
console.log('Launching 4 concurrent test processes...\n');

function runTest() {
    return new Promise((resolve, reject) => {
        const proc = spawn('yarn', ['test'], {
            stdio: 'inherit',
            shell: true
        });
        
        proc.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`Process exited with code ${code}`));
            }
        });
        
        proc.on('error', reject);
    });
}

Promise.all([
    runTest(),
    runTest(),
    runTest(),
    runTest()
])
.then(() => {
    console.log('\n\nAll sampling complete. Running verification...\n');
    
    const verify = spawn('yarn', ['test', 'verify'], {
        stdio: 'inherit',
        shell: true
    });
    
    verify.on('close', (code) => {
        process.exit(code);
    });
})
.catch((err) => {
    console.error('Error running tests:', err);
    process.exit(1);
});
