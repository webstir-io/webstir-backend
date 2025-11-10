# @webstir-io/webstir-backend

Backend build orchestration for Webstir workspaces. The package exposes a `ModuleProvider` that type‑checks with TypeScript, builds with esbuild, collects build artifacts, and returns diagnostics for the Webstir CLI and installers.

## Quick Start

1. **Authenticate to GitHub Packages**
   Configure user-level auth (recommended) or set an env var:
   - User config (`~/.npmrc`):
     ```ini
     @webstir-io:registry=https://npm.pkg.github.com
     //npm.pkg.github.com/:_authToken=${GH_PACKAGES_TOKEN}
     ```
   - Or export a token (CI uses `NODE_AUTH_TOKEN`):
     ```bash
     export NODE_AUTH_TOKEN="$GH_PACKAGES_TOKEN"
     ```
   Consumers need `read:packages`; publishers also require `write:packages`.
2. **Install**
   ```bash
   npm install @webstir-io/webstir-backend
   ```
3. **Run a build**
   ```ts
   import { backendProvider } from '@webstir-io/webstir-backend';

   const { manifest } = await backendProvider.build({
     workspaceRoot: '/absolute/path/to/workspace',
     env: { WEBSTIR_MODULE_MODE: 'build' },
     incremental: true
   });

   console.log(manifest.entryPoints);
   ```

Requires Node.js **20.18.x** or newer.

## Workspace Layout

```
workspace/
  src/backend/
    tsconfig.json
    index.ts                 # optional monolithic server entry
    functions/*/index.ts     # optional function handlers
    jobs/*/index.ts          # optional job/worker entries
    handlers/
    tests/
  build/backend/...    # compiled JS output
```

The provider expects a standard workspace layout and performs two steps:

1) Type checking via `tsc -p src/backend/tsconfig.json --noEmit` (can be skipped in dev; see below)
2) Build via esbuild into `build/backend`:
   - build/test: transpile only (no bundle), sourcemaps on
   - publish: bundle each entry, externalize node_modules, minify, strip comments

## Provider Contract

`backendProvider` implements `ModuleProvider` from `@webstir-io/module-contract`:

- `metadata` — package id, version, kind (`backend`), CLI compatibility, Node range.
- `resolveWorkspace({ workspaceRoot })` — returns canonical source/build/test roots.
- `build(options)` — type‑checks with `tsc --noEmit`, then runs esbuild. In `build`/`test` mode it transpiles without bundling; in `publish` it bundles workspace code, externalizes `node_modules`, minifies, strips comments, and defines `NODE_ENV=production`. Artifacts are gathered and a manifest describing entry points, diagnostics, and the module contract manifest is returned.
- `getScaffoldAssets()` — returns starter files to bootstrap a backend workspace:
  - `src/backend/tsconfig.json` (NodeNext, outDir `build/backend`)
  - `src/backend/index.ts` (minimal entry: logs ports and mode)
  - `src/backend/server/fastify.ts` (optional Fastify server scaffold)

### Fastify Scaffold (optional)

If you prefer a Fastify-based server over the minimal Node HTTP sample:

- Install Fastify in your workspace:
  ```bash
  npm i fastify
  ```
- Import and start it from your `src/backend/index.ts`:
  ```ts
  // src/backend/index.ts
  import { start } from './server/fastify';
  start().catch((err) => { console.error(err); process.exit(1); });
  ```
- Or run it directly after a build:
  ```bash
  node build/backend/server/fastify.js
  ```

Note: The package’s smoke test temporarily installs Fastify only to type‑check the optional scaffold. Normal users do not need Fastify unless they choose to use this server. In CI or offline environments, set `WEBSTIR_BACKEND_SMOKE_FASTIFY=skip` to bypass the Fastify install and type‑check.

When present, the Fastify scaffold will also attempt to auto‑mount any compiled module routes it finds under `build/backend/module(.js)`. Export your module definition as `module`, `moduleDefinition`, or the `default` export from `src/backend/module.ts` and build; the server will attach handlers using the route metadata.

### Module Manifest Integration

When `build()` completes, it now returns a `ModuleBuildManifest` with a `module` property that matches the contract introduced in `@webstir-io/module-contract@0.1.5`. The provider looks for module metadata in the workspace’s `package.json` under `webstir.module`. If present, the object is validated against the shared `moduleManifestSchema`; otherwise, sane defaults are generated from the workspace package name/version.

```jsonc
// workspace/package.json
{
  "name": "@demo/accounts",
  "version": "0.1.0",
  "webstir": {
    "module": {
      "contractVersion": "1.0.0",
      "name": "@demo/accounts",
      "version": "0.1.0",
      "capabilities": ["auth", "views"],
      "routes": [],
      "views": []
    }
  }
}
```

If the manifest fails validation, the provider emits a diagnostic and falls back to a minimal contract (name/version/kind only). This keeps consuming tooling resilient while still surfacing issues to the developer.

After a build, the provider also tries to load `build/backend/module.js` (compiled from `src/backend/module.ts`). Export a `createModule(...)` definition as `module`, `moduleDefinition`, or `default` to have routes, views, and capabilities hydrated automatically.

#### ts-rest Router Example

```ts
// src/backend/module.ts
import { initContract } from '@ts-rest/core';
import { createModule, fromTsRestRouter, CONTRACT_VERSION, type RequestContext } from '@webstir-io/module-contract';
import { z } from 'zod';

const c = initContract();

const accountSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email()
});

const router = c.router({
  list: c.query({
    path: '/accounts',
    method: 'GET',
    responses: {
      200: z.object({ data: z.array(accountSchema) })
    }
  }),
  detail: c.query({
    path: '/accounts/:id',
    method: 'GET',
    pathParams: z.object({ id: z.string().uuid() }),
    responses: {
      200: accountSchema,
      404: z.null()
    }
  })
});

const routeSpecs = fromTsRestRouter<RequestContext>({
  router,
  baseName: 'accounts',
  createRoute: ({ keyPath }) => ({
    handler: async (ctx) => {
      if (keyPath.at(-1) === 'detail') {
        const row = await ctx.db.accounts.findById(ctx.params.id);
        return row
          ? { status: 200, body: row }
          : { status: 404, errors: [{ code: 'not_found', message: 'Account not found' }] };
      }

      const rows = await ctx.db.accounts.list();
      return { status: 200, body: { data: rows } };
    }
  })
});

export const module = createModule({
  manifest: {
    contractVersion: CONTRACT_VERSION,
    name: '@demo/accounts',
    version: '0.1.0',
    kind: 'backend',
    capabilities: ['db', 'auth'],
    routes: routeSpecs.map((route) => route.definition)
  },
  routes: routeSpecs
});
```

When `npm run build` completes, the provider detects `build/backend/module.js`, hydrates the manifest with the `routes` metadata above, and returns it to the orchestrator alongside the compiled entry points.

### Multiple Entry Points
The provider discovers these entries automatically (all optional):

- `src/backend/index.{ts,tsx,js,mjs}`
- `src/backend/functions/*/index.{ts,tsx,js,mjs}`
- `src/backend/jobs/*/index.{ts,tsx,js,mjs}`

Outputs mirror the source layout under `build/backend/**/index.js`. The manifest lists relative `index.js` paths for all entries.

Artifacts are returned as absolute paths so installers can copy or upload them. A missing `index.js` triggers a warning diagnostic.

## NPM Scripts

| Script | Description |
|--------|-------------|
| `npm run build` | Compiles provider TypeScript from `src/` into `dist/`. |
| `npm test` | Builds and runs Node's test runner over `tests/**/*.test.js`. |
| `npm run smoke` | Quick end-to-end check: scaffolds a temp workspace and runs build/publish via the provider. |
| `npm run clean` | Removes `dist/`. |

The published package ships prebuilt JavaScript and type definitions in `dist/`.

## Maintainer Workflow

```bash
npm install
npm run build          # emits dist/
npm run test           # runs unit/integration tests
# Optional quick E2E
npm run smoke
```

- Add tests under `tests/**/*.test.ts` and wire them into `npm test` once the backend runtime is ready.
- Ensure CI runs `npm ci`, `npm run build`, and any smoke tests before publish.
- Publishing targets GitHub Packages via `publishConfig.registry`.
- Reference implementation: `examples/accounts/` demonstrates a ts-rest powered module exporting `createModule()` for provider hydration.
- Use `npm run release -- <patch|minor|major|x.y.z>` to bump the version, build, test, run the smoke check, and publish via the bundled helper script.

## Troubleshooting

- “TypeScript config not found at src/backend/tsconfig.json; skipping type-check.” — esbuild can still build, but path aliases and stricter checks may be skipped. Add a workspace `src/backend/tsconfig.json`.
- “No backend entry point found” — ensure `src/backend/index.ts` (or `index.js`) exists. The provider looks for `index.*` and emits `build/backend/index.js`.
- esbuild warnings/errors are surfaced as diagnostics with file locations when available.

CI notes
- Package CI runs build + tests on PRs and main; a smoke step runs on main only to exercise the end-to-end path quickly.

Dev tips
- Fast iteration: set `WEBSTIR_BACKEND_TYPECHECK=skip` to bypass type-checking during `build`/`test` mode. Type-checks always run for `publish`.
- Publish sourcemaps: set `WEBSTIR_BACKEND_SOURCEMAPS=on` (before `webstir publish` or provider builds) to bundle `.js.map` files alongside the minified output. The maps are excluded by default to keep bundle sizes lean.
- **`TypeScript config not found` warning** — ensure `src/backend/tsconfig.json` exists.
- **`Backend TypeScript compilation failed`** — inspect diagnostics (stderr/stdout captured in the manifest) and rerun `tsc -p`.
- **No backend entry point found** — confirm `build/backend/index.js` exists after compilation or adjust the build output.

## License

MIT © Webstir
### Watch Mode (developer convenience)

Start incremental builds with type-checking in the background:

```bash
npm run dev           # type-check + transpile on change
npm run dev:fast      # faster DX: skip tsc in watch
```

Notes
- Set `WEBSTIR_BACKEND_DIAG_MAX=<n>` to cap how many esbuild diagnostics print per rebuild (default: 20 in standalone watch, 50 in provider builds invoked by the orchestrator).
- Publish still enforces `tsc --noEmit` even if you skip type-checking in watch.
- After each rebuild you’ll see concise summaries and a manifest glance, for example:
  - `watch:esbuild 0 error(s), N warning(s) in X ms`
- `watch:manifest routes=N views=M [capabilities]`

Or programmatically:

```ts
import { startBackendWatch } from '@webstir-io/webstir-backend';

const handle = await startBackendWatch({
  workspaceRoot: '/abs/path/to/workspace',
  env: { WEBSTIR_MODULE_MODE: 'build' }
});

// later
await handle.stop();
```

### Functions & Jobs (scaffolding)

The provider ships example entries you can copy into a fresh workspace:

- `src/backend/functions/hello/index.ts` — a simple function entry
- `src/backend/jobs/nightly/index.ts` — a simple job entry

If you use `getScaffoldAssets()` programmatically, these templates are included alongside `tsconfig.json` and `index.ts`.

### Dev runner readiness

- The backend template listens on `process.env.PORT` (default `4000`) and logs `API server running` when ready.
- The orchestrator's dev server waits for that readiness line and proxies `/api/*` to your Node server.
- A basic `GET /api/health` endpoint is included for quick checks.
- If you switch to a framework (e.g., Fastify), keep the same behavior: listen on `process.env.PORT` and print `API server running` once the server is listening.
