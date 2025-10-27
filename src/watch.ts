import path from 'node:path';
import { existsSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { context as createEsbuildContext, type BuildContext, type BuildResult, type Plugin } from 'esbuild';
import { glob } from 'glob';

import type { ResolvedModuleWorkspace } from '@webstir-io/module-contract';

function resolveWorkspacePaths(workspaceRoot: string): ResolvedModuleWorkspace {
  return {
    sourceRoot: path.join(workspaceRoot, 'src', 'backend'),
    buildRoot: path.join(workspaceRoot, 'build', 'backend'),
    testsRoot: path.join(workspaceRoot, 'src', 'backend', 'tests'),
  };
}

function normalizeMode(rawMode: unknown): 'build' | 'publish' | 'test' {
  if (typeof rawMode !== 'string') return 'build';
  const normalized = rawMode.toLowerCase();
  return normalized === 'publish' || normalized === 'test' ? normalized : 'build';
}

async function discoverEntryPoints(sourceRoot: string): Promise<string[]> {
  const patterns = [
    'index.{ts,tsx,js,mjs}',
    'functions/*/index.{ts,tsx,js,mjs}',
    'jobs/*/index.{ts,tsx,js,mjs}',
  ];
  const entries = new Set<string>();
  for (const pattern of patterns) {
    const matches = await glob(pattern, { cwd: sourceRoot, nodir: true, dot: false });
    for (const rel of matches) {
      entries.add(path.join(sourceRoot, rel));
    }
  }
  return Array.from(entries);
}

export interface WatchHandle {
  stop(): Promise<void>;
}

export interface StartWatchOptions {
  readonly workspaceRoot: string;
  readonly env?: Record<string, string | undefined>;
}

export async function startBackendWatch(options: StartWatchOptions): Promise<WatchHandle> {
  const { workspaceRoot } = options;
  const env = options.env ?? {};
  const paths = resolveWorkspacePaths(workspaceRoot);
  const tsconfigPath = path.join(paths.sourceRoot, 'tsconfig.json');
  const mode = normalizeMode(env.WEBSTIR_MODULE_MODE);

  const entryPoints = await discoverEntryPoints(paths.sourceRoot);
  if (entryPoints.length === 0) {
    console.warn(`[webstir-backend] watch: no entry found under ${paths.sourceRoot} (index.ts/js)`);
    throw new Error('No backend entry point found.');
  }

  const nodeEnv = env.NODE_ENV ?? (mode === 'publish' ? 'production' : 'development');

  console.info(`[webstir-backend] watch:start (${mode})`);

  // Start type-checker in watch mode (no emit)
  const tscArgs = ['-p', tsconfigPath, '--noEmit', '--watch'];
  const tscProc: ChildProcess = spawn('tsc', tscArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env, NODE_ENV: nodeEnv },
    cwd: workspaceRoot,
  });

  tscProc.stdout?.on('data', (chunk) => {
    const text = chunk.toString();
    for (const line of text.split(/\r?\n/)) {
      if (line) console.info(`[webstir-backend][tsc] ${line}`);
    }
  });
  tscProc.stderr?.on('data', (chunk) => {
    const text = chunk.toString();
    for (const line of text.split(/\r?\n/)) {
      if (line) console.warn(`[webstir-backend][tsc] ${line}`);
    }
  });

  // Esbuild context with incremental rebuilds
  const timingPlugin: Plugin = {
    name: 'webstir-watch-logger',
    setup(build) {
      let start = 0;
      build.onStart(() => {
        start = performance.now();
      });
      build.onEnd((result: BuildResult) => {
        const end = performance.now();
        const warnCount = result.warnings?.length ?? 0;
        console.info(`[webstir-backend] watch:esbuild completed in ${(end - start).toFixed(1)}ms with ${warnCount} warning(s).`);
      });
    },
  };

  const ctx: BuildContext = await createEsbuildContext({
    entryPoints,
    bundle: false,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    sourcemap: true,
    outdir: paths.buildRoot,
    outbase: paths.sourceRoot,
    tsconfig: existsSync(tsconfigPath) ? tsconfigPath : undefined,
    define: { 'process.env.NODE_ENV': JSON.stringify(nodeEnv) },
    logLevel: 'silent',
    plugins: [timingPlugin],
  });

  await ctx.watch();

  console.info('[webstir-backend] watch:ready');

  return {
    async stop() {
      try {
        await ctx.dispose();
      } catch {
        // ignore
      }
      try {
        tscProc.kill('SIGINT');
      } catch {
        // ignore
      }
      console.info('[webstir-backend] watch:stopped');
    },
  };
}
