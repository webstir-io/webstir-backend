import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { backendProvider } from '../dist/index.js';

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
  for (const asset of assets) {
    if (!asset.targetPath.endsWith(path.join('backend', 'index.ts'))) continue;
    const target = path.join(workspace, asset.targetPath);
    await copyFile(asset.sourcePath, target);
  }

  const envBase = { PATH: `${getLocalBinPath()}${path.delimiter}${process.env.PATH ?? ''}` };

  console.info('[smoke] build mode');
  const buildResult = await backendProvider.build({ workspaceRoot: workspace, env: { ...envBase, WEBSTIR_MODULE_MODE: 'build' }, incremental: false });
  console.info('[smoke] build entryPoints:', buildResult.manifest.entryPoints);
  console.info('[smoke] build diagnostics:', buildResult.manifest.diagnostics.map(d => d.message));

  console.info('[smoke] publish mode');
  const publishResult = await backendProvider.build({ workspaceRoot: workspace, env: { ...envBase, WEBSTIR_MODULE_MODE: 'publish' }, incremental: false });
  console.info('[smoke] publish entryPoints:', publishResult.manifest.entryPoints);
  console.info('[smoke] publish diagnostics:', publishResult.manifest.diagnostics.map(d => d.message));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
