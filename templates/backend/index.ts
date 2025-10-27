// Minimal typing to avoid requiring @types/node in fresh workspaces
declare const process: any;

export async function start(): Promise<void> {
  const apiPort = Number(process.env.API_PORT ?? 4000);
  const webPort = Number(process.env.WEB_PORT ?? 5173);
  const mode = process.env.NODE_ENV ?? 'development';
  console.info(`[webstir-backend] start (mode=${mode}) api:${apiPort} web:${webPort}`);
}

// Execute when launched directly: `node build/backend/index.js`
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
  start().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
