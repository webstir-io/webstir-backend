// Minimal Node HTTP server for dev runner readiness
import http from 'node:http';

export async function start(): Promise<void> {
  const port = Number(process.env.PORT ?? 4000);
  const mode = process.env.NODE_ENV ?? 'development';

  const server = http.createServer((req, res) => {
    if (req.url === '/api/health') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => resolve());
  });

  // Dev runner (webstir-dotnet) watches for this readiness line
  console.info('API server running');
  console.info(`[webstir-backend] mode=${mode} port=${port}`);
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
