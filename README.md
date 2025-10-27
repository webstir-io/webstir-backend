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
- `build(options)` — type‑checks with `tsc --noEmit`, then runs esbuild. In `build`/`test` mode it transpiles without bundling; in `publish` it bundles workspace code, externalizes `node_modules`, minifies, strips comments, and defines `NODE_ENV=production`. Artifacts are gathered and a manifest describing entry points and diagnostics is returned.
- `getScaffoldAssets()` — returns starter files to bootstrap a backend workspace:
  - `src/backend/tsconfig.json` (NodeNext, outDir `build/backend`)
  - `src/backend/index.ts` (minimal entry: logs ports and mode)

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

## Troubleshooting

- “TypeScript config not found at src/backend/tsconfig.json; skipping type-check.” — esbuild can still build, but path aliases and stricter checks may be skipped. Add a workspace `src/backend/tsconfig.json`.
- “No backend entry point found” — ensure `src/backend/index.ts` (or `index.js`) exists. The provider looks for `index.*` and emits `build/backend/index.js`.
- esbuild warnings/errors are surfaced as diagnostics with file locations when available.

CI notes
- Package CI runs build + tests on PRs and main; a smoke step runs on main only to exercise the end-to-end path quickly.

Dev tips
- Fast iteration: set `WEBSTIR_BACKEND_TYPECHECK=skip` to bypass type-checking during `build`/`test` mode. Type-checks always run for `publish`.
- **`TypeScript config not found` warning** — ensure `src/backend/tsconfig.json` exists.
- **`Backend TypeScript compilation failed`** — inspect diagnostics (stderr/stdout captured in the manifest) and rerun `tsc -p`.
- **No backend entry point found** — confirm `build/backend/index.js` exists after compilation or adjust the build output.

## License

MIT © Webstir
### Watch Mode (developer convenience)

Start incremental builds with type-checking in the background:

```bash
npm run watch
```

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
