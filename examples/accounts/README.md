# Accounts Backend Example

Demonstrates how a backend workspace can expose routes via the shared module contract helpers.

## Usage

```bash
npm install
npm run build
```

`npm run build` compiles `src/backend/module.ts` into `dist/backend/module.js`. When the `@webstir-io/webstir-backend` provider runs against this workspace, it detects the compiled module definition, merges the exported manifest/routes, and returns them to the orchestrator.

> Install requires GitHub Packages credentials for `@webstir-io/*` packages. Configure `.npmrc` as documented in the root README.
