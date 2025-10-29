// Example job entry (scheduled by your orchestrator)
// This is a simple placeholder; connect it to your scheduler of choice.

export async function run(): Promise<void> {
  // Do some nightly maintenance work here
  console.info('[job:nightly] ran at', new Date().toISOString());
}

// Execute when launched directly: `node build/backend/jobs/nightly/index.js`
const isMain = (() => {
  try {
    const argv1 = process.argv?.[1];
    if (!argv1) return false;
    const here = new URL(import.meta.url);
    const run = new URL(`file://${argv1}`);
    return here.pathname === run.pathname;
  } catch {
    return false;
  }
})();

if (isMain) {
  run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

