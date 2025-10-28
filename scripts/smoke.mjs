import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { backendProvider } from '../dist/index.js';
import { CONTRACT_VERSION } from '@webstir-io/module-contract';

function getLocalBinPath() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pkgRoot = path.resolve(here, '..');
  return path.join(pkgRoot, 'node_modules', '.bin');
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function copyFile(src, dest) {
  await ensureDir(path.dirname(dest));
  await fs.copyFile(src, dest);
}

async function main() {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'webstir-backend-smoke-'));
  const assets = await backendProvider.getScaffoldAssets();
  await Promise.all(
    assets.map(async (asset) => {
      const target = path.join(workspace, asset.targetPath);
      await copyFile(asset.sourcePath, target);
    })
  );

  const backendTsconfigPath = path.join(workspace, 'src', 'backend', 'tsconfig.json');
  try {
    const backendTsconfigRaw = await fs.readFile(backendTsconfigPath, 'utf8');
    const backendTsconfig = JSON.parse(backendTsconfigRaw);
    if (backendTsconfig?.compilerOptions) {
      delete backendTsconfig.compilerOptions.types;
    }
    await fs.writeFile(backendTsconfigPath, `${JSON.stringify(backendTsconfig, null, 2)}\n`, 'utf8');
  } catch (error) {
    console.warn('[smoke] failed to adjust backend tsconfig:', error);
  }

  const packageJsonPath = path.join(workspace, 'package.json');
  const packageJson = {
    name: '@smoke/backend',
    version: '0.0.0',
    private: true,
    type: 'module',
    webstir: {
      module: {
        contractVersion: CONTRACT_VERSION,
        name: '@smoke/backend',
        version: '0.0.0',
        kind: 'backend',
        capabilities: [],
        routes: [],
        views: []
      }
    }
  };
  await fs.writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');

  const rootTsconfigPath = path.join(workspace, 'tsconfig.json');
  const rootTsconfig = {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      resolveJsonModule: true,
      strict: true,
      isolatedModules: true,
      esModuleInterop: true,
      skipLibCheck: true
    }
  };
  await fs.writeFile(rootTsconfigPath, `${JSON.stringify(rootTsconfig, null, 2)}\n`, 'utf8');

  const envBase = {
    PATH: `${getLocalBinPath()}${path.delimiter}${process.env.PATH ?? ''}`,
    WEBSTIR_BACKEND_TYPECHECK: 'skip'
  };

  console.info('[smoke] build mode');
  const buildResult = await backendProvider.build({
    workspaceRoot: workspace,
    env: { ...envBase, WEBSTIR_MODULE_MODE: 'build' },
    incremental: false
  });
  console.info('[smoke] build entryPoints:', buildResult.manifest.entryPoints);
  console.info('[smoke] build diagnostics:', buildResult.manifest.diagnostics.filter((d) => d.severity !== 'info').map((d) => d.message));

  console.info('[smoke] publish mode');
  const publishResult = await backendProvider.build({
    workspaceRoot: workspace,
    env: { ...envBase, WEBSTIR_MODULE_MODE: 'publish' },
    incremental: false
  });
  console.info('[smoke] publish entryPoints:', publishResult.manifest.entryPoints);
  console.info('[smoke] publish diagnostics:', publishResult.manifest.diagnostics.filter((d) => d.severity !== 'info').map((d) => d.message));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
