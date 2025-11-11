import http from 'node:http';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { loadEnv } from './env';

type RouteHandlerResult = {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  errors?: { code: string; message: string }[];
};

type RouteHandler = (ctx: RouteContext) => Promise<RouteHandlerResult> | RouteHandlerResult;

interface RouteContext {
  request: http.IncomingMessage;
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  env: {
    get: (name: string) => string | undefined;
    require: (name: string) => string;
    entries: () => Record<string, string | undefined>;
  };
  logger: Console;
  now: () => Date;
}

interface ModuleRoute {
  definition?: {
    method?: string;
    path?: string;
  };
  handler?: RouteHandler;
}

interface ModuleDefinitionLike {
  routes?: ModuleRoute[];
}

interface CompiledRoute {
  method: string;
  match: (pathname: string) => { matched: boolean; params: Record<string, string> };
  handler: RouteHandler;
}

export async function start(): Promise<void> {
  const env = loadEnv();
  const port = env.PORT;
  const mode = env.NODE_ENV;

  const routes = await loadCompiledRoutes();
  const server = http.createServer(async (req, res) => {
    try {
      if (!req.url) {
        res.statusCode = 400;
        res.end('Bad Request');
        return;
      }

      const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
      const pathname = normalizePath(url.pathname);

      if (pathname === '/api/health') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      const compiled = matchRoute(routes, req.method ?? 'GET', pathname);
      if (!compiled) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'not_found' }));
        return;
      }

      const body = await readRequestBody(req);
      const ctx: RouteContext = {
        request: req,
        params: compiled.params,
        query: Object.fromEntries(url.searchParams.entries()),
        body,
        env: {
          get: (name) => process.env[name],
          require: (name) => {
            const value = process.env[name];
            if (value === undefined) {
              throw new Error(`Missing required env var ${name}`);
            }
            return value;
          },
          entries: () => ({ ...process.env })
        },
        logger: console,
        now: () => new Date()
      };

      const result = await compiled.handler(ctx);
      const status = result.status ?? (result.errors ? 400 : 200);
      res.statusCode = status;
      const headers = result.headers ?? { 'Content-Type': 'application/json' };
      for (const [key, value] of Object.entries(headers)) {
        res.setHeader(key, value);
      }
      if (result.errors) {
        res.end(JSON.stringify({ errors: result.errors }));
      } else if (result.body === undefined || result.body === null) {
        res.end('');
      } else if (typeof result.body === 'string' || Buffer.isBuffer(result.body)) {
        res.end(result.body);
      } else {
        res.end(JSON.stringify(result.body));
      }
    } catch (error) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'internal_error', details: (error as Error).message }));
      console.error('[webstir-backend] route handler failed', error);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => resolve());
  });

  console.info('API server running');
  console.info(`[webstir-backend] mode=${mode} port=${port}`);
}

async function loadCompiledRoutes(): Promise<CompiledRoute[]> {
  const definition = await tryLoadModuleDefinition();
  if (!definition?.routes || definition.routes.length === 0) {
    return [];
  }

  return definition.routes
    .map((route) => compileRoute(route))
    .filter((route): route is CompiledRoute => route !== undefined);
}

function compileRoute(route: ModuleRoute): CompiledRoute | undefined {
  const method = (route.definition?.method ?? 'GET').toUpperCase();
  const pathPattern = normalizePath(route.definition?.path ?? '/');
  const handler = route.handler;
  if (typeof handler !== 'function') {
    return undefined;
  }
  const matcher = createPathMatcher(pathPattern);
  return {
    method,
    match: matcher,
    handler
  };
}

function createPathMatcher(pattern: string) {
  const paramRegex = /:[A-Za-z0-9_]+/g;
  const regex = new RegExp(
    '^' +
      pattern
        .replace(/\//g, '\\/')
        .replace(paramRegex, (segment) => `(?<${segment.slice(1)}>[^/]+)`) +
      '$'
  );
  return (pathname: string) => {
    const match = regex.exec(pathname);
    if (!match) {
      return { matched: false, params: {} };
    }
    const params = (match.groups ?? {}) as Record<string, string>;
    return { matched: true, params };
  };
}

function matchRoute(routes: CompiledRoute[], method: string, pathname: string) {
  const normalizedMethod = method.toUpperCase();
  for (const route of routes) {
    if (route.method !== normalizedMethod) continue;
    const { matched, params } = route.match(pathname);
    if (matched) {
      return { handler: route.handler, params };
    }
  }
  return undefined;
}

async function tryLoadModuleDefinition(): Promise<ModuleDefinitionLike | undefined> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = ['module.js', 'module.mjs', 'module/index.js', 'module/index.mjs'];
  for (const rel of candidates) {
    const full = path.join(here, rel);
    try {
      const url = pathToFileURL(full).href + `?t=${Date.now()}`;
      const imported = await import(url);
      const definition = (imported.module || imported.moduleDefinition || imported.default) as ModuleDefinitionLike;
      if (definition && typeof definition === 'object') {
        console.info(`[webstir-backend] loaded module definition from ${rel}`);
        return definition;
      }
    } catch {
      // ignore and continue
    }
  }
  return undefined;
}

async function readRequestBody(req: http.IncomingMessage): Promise<unknown> {
  if (req.method === 'GET' || req.method === 'HEAD') {
    return undefined;
  }
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  if (chunks.length === 0) {
    return undefined;
  }
  const buffer = Buffer.concat(chunks);
  const contentType = String(req.headers['content-type'] ?? '');
  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(buffer.toString('utf8'));
    } catch {
      return undefined;
    }
  }
  return buffer.toString('utf8');
}

function normalizePath(value: string | undefined): string {
  if (!value || value === '/') return '/';
  const normalized = value.endsWith('/') ? value.slice(0, -1) : value;
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

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
