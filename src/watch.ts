import path from 'node:path';
import { existsSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
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
  const diagMax = (() => {
    const raw = env.WEBSTIR_BACKEND_DIAG_MAX;
    const n = typeof raw === 'string' ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 20;
  })();

  console.info(`[webstir-backend] watch:start (${mode})`);

  // Start type-checker in watch mode (no emit) unless explicitly skipped for DX.
  const skipTypecheck = typeof env.WEBSTIR_BACKEND_TYPECHECK === 'string' && env.WEBSTIR_BACKEND_TYPECHECK.toLowerCase() === 'skip';
  let tscProc: ChildProcess | undefined;
  if (!skipTypecheck) {
    const tscArgs = ['-p', tsconfigPath, '--noEmit', '--watch'];
    tscProc = spawn('tsc', tscArgs, {
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
  } else {
    console.info('[webstir-backend] watch: type-check skipped by WEBSTIR_BACKEND_TYPECHECK');
  }

  // Esbuild context with incremental rebuilds
  // Debounced manifest summary after builds
  let summaryTimer: NodeJS.Timeout | undefined;
  const scheduleSummary = () => {
    if (summaryTimer) clearTimeout(summaryTimer);
    summaryTimer = setTimeout(async () => {
      try {
        const summary = await summarizeManifest(paths.buildRoot);
        if (summary) {
          const { routes, views, capabilities } = summary;
          const caps = (capabilities && capabilities.length > 0) ? ` [${capabilities.join(', ')}]` : '';
          console.info(`[webstir-backend] watch:manifest routes=${routes} views=${views}${caps}`);
        }
      } catch {
        // ignore summary errors; dev convenience
      }
    }, 100);
  };

  // Track outputs between rebuilds to report changed files
  const previousOutputs = new Map<string, number>();

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
        // errors is not in the typed result, but present at runtime
        const errorList = (result as any).errors ?? [];
        const errorCount = Array.isArray(errorList) ? errorList.length : 0;
        // Print detailed diagnostics with file:line when available (capped for readability)
        if (errorCount > 0) {
          for (const msg of errorList.slice(0, diagMax)) {
            const text = formatEsbuildMessage(msg);
            console.error(`[webstir-backend][esbuild] ${text}`);
          }
          if (errorCount > diagMax) {
            console.error(`[webstir-backend][esbuild] ... ${errorCount - diagMax} more error(s) omitted`);
          }
        }
        if (warnCount > 0) {
          for (const msg of result.warnings.slice(0, diagMax)) {
            const text = formatEsbuildMessage(msg as any);
            console.warn(`[webstir-backend][esbuild] ${text}`);
          }
          if (warnCount > diagMax) {
            console.warn(`[webstir-backend][esbuild] ... ${warnCount - diagMax} more warning(s) omitted`);
          }
        }
        console.info(`[webstir-backend] watch:esbuild ${errorCount} error(s), ${warnCount} warning(s) in ${(end - start).toFixed(1)}ms`);

        // Changed-files summary using metafile outputs
        try {
          const metafile: any = (result as any).metafile;
          if (metafile && metafile.outputs) {
            const outputs = metafile.outputs as Record<string, { bytes?: number }>;
            const changed: string[] = [];
            for (const [outPath, info] of Object.entries(outputs)) {
              const bytes = typeof info.bytes === 'number' ? info.bytes : 0;
              const prev = previousOutputs.get(outPath);
              if (prev === undefined || prev !== bytes) {
                changed.push(outPath);
              }
            }
            previousOutputs.clear();
            for (const [outPath, info] of Object.entries(outputs)) {
              previousOutputs.set(outPath, typeof info.bytes === 'number' ? info.bytes : 0);
            }
            if (changed.length > 0) {
              const list = changed
                .map((p) => path.relative(paths.buildRoot, p))
                .slice(0, diagMax)
                .join(', ');
              const omitted = changed.length > diagMax ? ` (+${changed.length - diagMax} more)` : '';
              console.info(`[webstir-backend] watch:changed ${changed.length} file(s): ${list}${omitted}`);
            }
          }
        } catch {
          // ignore metafile parse errors in dev
        }
        scheduleSummary();
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
    metafile: true,
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
        tscProc?.kill('SIGINT');
      } catch {
        // ignore
      }
      console.info('[webstir-backend] watch:stopped');
    },
  };
}

function formatEsbuildMessage(msg: any): string {
  const text = typeof msg?.text === 'string' ? msg.text : String(msg);
  const loc = msg?.location;
  if (loc && typeof loc.file === 'string') {
    const position = typeof loc.line === 'number' ? `${loc.line}:${loc.column ?? 1}` : '1:1';
    return `${loc.file}:${position} ${text}`;
  }
  return text;
}

async function summarizeManifest(buildRoot: string): Promise<{ routes: number; views: number; capabilities?: readonly string[] } | undefined> {
  // Try to import a built module definition and extract counts
  const candidates = [
    path.join(buildRoot, 'module.js'),
    path.join(buildRoot, 'module.mjs'),
    path.join(buildRoot, 'module', 'index.js'),
    path.join(buildRoot, 'module', 'index.mjs'),
  ];
  for (const fullPath of candidates) {
    if (!existsSync(fullPath)) continue;
    try {
      const url = `${pathToFileURL(fullPath).href}?t=${Date.now()}`;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const imported: any = await import(url);
      const def = imported?.module ?? imported?.moduleDefinition ?? imported?.default ?? imported?.backendModule;
      const manifest = def?.manifest as { routes?: unknown[]; views?: unknown[]; capabilities?: readonly string[] } | undefined;
      if (manifest && (manifest.routes || manifest.views)) {
        return {
          routes: Array.isArray(manifest.routes) ? manifest.routes.length : 0,
          views: Array.isArray(manifest.views) ? manifest.views.length : 0,
          capabilities: manifest.capabilities,
        };
      }
    } catch {
      // ignore import errors during dev
    }
  }
  return undefined;
}
