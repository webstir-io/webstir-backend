// Optional Fastify server scaffold for richer routing
// Rename or import into your backend index to use.
import Fastify from 'fastify';

async function tryLoadModuleDefinition(): Promise<any | undefined> {
  const candidates = ['../module.js', '../module/index.js'];
  for (const rel of candidates) {
    try {
      const url = new URL(rel, import.meta.url);
      const mod = await import(url.toString());
      const def = (mod && (mod.module || mod.moduleDefinition || mod.default)) as any;
      if (def && typeof def === 'object') return def;
    } catch {
      // ignore and try next
    }
  }
  return undefined;
}

function mountRoutes(app: import('fastify').FastifyInstance, definition: any) {
  const routes = Array.isArray(definition?.routes) ? definition.routes : [];
  for (const r of routes) {
    try {
      const method: string = String(r.definition?.method ?? 'GET').toLowerCase();
      const path: string = String(r.definition?.path ?? '/');
      const handler = r.handler;
      if (typeof handler !== 'function') continue;

      // Use app.route for flexibility across methods
      app.route({
        method: method.toUpperCase() as any,
        url: path,
        handler: async (req, reply) => {
          const ctx: any = {
            request: req,
            reply,
            auth: undefined,
            session: null,
            db: {},
            env: {
              get: (n: string) => process.env[n],
              require: (n: string) => {
                const v = process.env[n];
                if (!v) throw new Error(`Missing required env var ${n}`);
                return v;
              },
              entries: () => ({ ...process.env })
            },
            logger: {
              level: 'info',
              log: (level: string, message: string) => console.log(`[${level}]`, message),
              debug: (m: string) => console.debug(m),
              info: (m: string) => console.info(m),
              warn: (m: string) => console.warn(m),
              error: (m: string) => console.error(m),
              with: () => this
            },
            requestId: (req as any).id ?? '',
            now: () => new Date(),
            params: (req as any).params ?? {},
            query: (req as any).query ?? {},
            body: (req as any).body ?? {}
          };
          const result = await handler(ctx);
          const status = (result as any)?.status ?? ((result as any)?.errors ? 400 : 200);
          const headers = (result as any)?.headers ?? {};
          for (const [k, v] of Object.entries(headers)) reply.header(k, String(v));
          if ((result as any)?.errors) {
            reply.code(status).send({ errors: (result as any).errors });
          } else {
            reply.code(status).send((result as any)?.body ?? null);
          }
        }
      });
      console.info(`[fastify] mounted ${method.toUpperCase()} ${path}`);
    } catch {
      // best-effort only; continue
    }
  }
}

export async function start(): Promise<void> {
  const port = Number(process.env.PORT ?? 4000);
  const mode = process.env.NODE_ENV ?? 'development';

  const app = Fastify({ logger: false });

  app.get('/api/health', async () => ({ ok: true }));

  // If a compiled module definition exists, mount its routes.
  try {
    const definition = await tryLoadModuleDefinition();
    if (definition) {
      mountRoutes(app, definition);
    }
  } catch {
    // ignore
  }

  await app.listen({ port, host: '0.0.0.0' });

  // Dev runner watches for this readiness line
  console.info('API server running');
  console.info(`[webstir-backend] mode=${mode} port=${port}`);
}

// Execute when launched directly
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
