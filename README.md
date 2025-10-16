# @webstir-io/webstir-backend

Default backend module provider for Webstir workspaces. The package compiles backend TypeScript sources, produces server bundles, and implements the module-provider contract consumed by the Webstir CLI.

## Install

```bash
npm install @webstir-io/webstir-backend
```

## Development

```bash
npm ci
npm run build
npm test
```

## Scripts

| Command        | Description                                   |
| -------------- | --------------------------------------------- |
| `npm run build` | Compile TypeScript sources to `dist/`.        |
| `npm run test`  | Build and execute the backend test suite.     |
| `npm run clean` | Remove build artifacts.                       |

## License

MIT © Electric Coding LLC and contributors
