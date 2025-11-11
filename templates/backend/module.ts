// Example manifest + route definition. Update the values to match your backend.
// This file is optional, but when present the backend server scaffold will load
// it from build/backend/module.js and automatically mount the handlers.

interface RouteHandlerResult {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  errors?: { code: string; message: string }[];
}

type RouteHandler = (ctx: RouteContext) => Promise<RouteHandlerResult> | RouteHandlerResult;

interface RouteContext {
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

const routes = [
  {
    definition: { method: 'GET', path: '/hello/:name' },
    handler: async (ctx: RouteContext) => ({
      status: 200,
      body: { message: `Hello ${ctx.params.name ?? 'world'}` }
    })
  }
];

export const module = {
  manifest: {
    contractVersion: '1.0.0',
    name: '@demo/backend',
    version: '0.1.0',
    kind: 'backend',
    capabilities: ['http'],
    routes: routes.map((route) => route.definition)
  },
  routes
};
