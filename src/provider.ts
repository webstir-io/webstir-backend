import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build as esbuild, context as esbuildContext } from 'esbuild';
import type { BuildContext as EsbuildContext } from 'esbuild';

import { glob } from 'glob';
import { moduleManifestSchema, CONTRACT_VERSION } from '@webstir-io/module-contract';
import type {
    ModuleArtifact,
    ModuleAsset,
    ModuleBuildOptions,
    ModuleBuildResult,
    ModuleDefinition,
    ModuleDiagnostic,
    ModuleManifest,
    ModuleProvider,
    ResolvedModuleWorkspace
} from '@webstir-io/module-contract';

import packageJson from '../package.json' with { type: 'json' };

interface PackageJson {
    readonly name: string;
    readonly version: string;
    readonly engines?: {
        readonly node?: string;
    };
}

const pkg = packageJson as PackageJson;

interface IncrementalBuildEntry {
    entrySignature: string;
    context: EsbuildContext;
}

const incrementalBuildCache = new Map<string, IncrementalBuildEntry>();

if (typeof process !== 'undefined' && typeof process.once === 'function') {
    process.once('exit', () => {
        clearIncrementalCache();
    });
}

interface WorkspacePackageJson {
    readonly name?: string;
    readonly version?: string;
    readonly webstir?: {
        readonly module?: WorkspaceModuleConfig;
    };
}

type WorkspaceModuleConfig = Partial<ModuleManifest> & {
    readonly contractVersion?: string;
    readonly capabilities?: ModuleManifest['capabilities'];
};

function resolveWorkspacePaths(workspaceRoot: string): ResolvedModuleWorkspace {
    return {
        sourceRoot: path.join(workspaceRoot, 'src', 'backend'),
        buildRoot: path.join(workspaceRoot, 'build', 'backend'),
        testsRoot: path.join(workspaceRoot, 'src', 'backend', 'tests')
    };
}

export const backendProvider: ModuleProvider = {
    metadata: {
        id: pkg.name ?? '@webstir-io/webstir-backend',
        kind: 'backend',
        version: pkg.version ?? '0.0.0',
        compatibility: {
            minCliVersion: '0.1.0',
            nodeRange: pkg.engines?.node ?? '>=20.18.1'
        }
    },
    resolveWorkspace(options) {
        return resolveWorkspacePaths(options.workspaceRoot);
    },
    async build(options) {
        const paths = resolveWorkspacePaths(options.workspaceRoot);
        const tsconfigPath = path.join(paths.sourceRoot, 'tsconfig.json');

        const diagnostics: ModuleDiagnostic[] = [];

        const incremental = options.incremental === true;
        const mode = normalizeMode(options.env?.WEBSTIR_MODULE_MODE);
        console.info(`[webstir-backend] ${mode}:start`);

        // 1) Type-check with TSC (no emit) if a tsconfig exists.
        console.info(`[webstir-backend] ${mode}:tsc start`);
        if (shouldTypeCheck(mode, options.env)) {
            await runTypeCheck(tsconfigPath, options.env, diagnostics);
        } else {
            diagnostics.push({ severity: 'info', message: '[webstir-backend] type-check skipped by WEBSTIR_BACKEND_TYPECHECK' });
        }
        console.info(`[webstir-backend] ${mode}:tsc done`);

        // 2) Transpile/bundle with esbuild based on mode.
        const entryPoints = await discoverEntryPoints(paths.sourceRoot);
        if (entryPoints.length === 0) {
            diagnostics.push({ severity: 'warn', message: `No backend entry points found under ${paths.sourceRoot} (expected index.* or functions/*/index.* or jobs/*/index.*).` });
        }
        console.info(`[webstir-backend] ${mode}:esbuild start`);
        const outputs = await runEsbuild({
            sourceRoot: paths.sourceRoot,
            buildRoot: paths.buildRoot,
            tsconfigPath,
            mode,
            env: options.env,
            incremental,
            diagnostics,
            entryPoints
        });
        console.info(`[webstir-backend] ${mode}:esbuild done`);

        const moduleSource = await discoverModuleDefinitionSource(paths.sourceRoot);

        if (moduleSource) {
            await buildModuleDefinition({
                sourceFile: moduleSource,
                sourceRoot: paths.sourceRoot,
                buildRoot: paths.buildRoot,
                tsconfigPath,
                mode,
                env: options.env,
                diagnostics
            });
        }

        const artifacts = await collectArtifacts(paths.buildRoot);
        const moduleManifest = await loadWorkspaceModuleManifest(options.workspaceRoot, paths.buildRoot, entryPoints, diagnostics);
        const manifest = createManifest(paths.buildRoot, artifacts, diagnostics, moduleManifest);

        console.info(`[webstir-backend] ${mode}:complete (entries=${manifest.entryPoints.length})`);
        diagnostics.push({ severity: 'info', message: `[webstir-backend] ${mode}:built entries=${manifest.entryPoints.length}` });
        try {
            // Categorize entries by bucket (server/functions/jobs)
            const server = manifest.entryPoints.filter((p) => p === 'index.js' || /(^|\/)index\.js$/.test(p) && !/^(functions|jobs)\//.test(p)).length;
            const functionsCount = manifest.entryPoints.filter((p) => p.startsWith('functions/')).length;
            const jobsCount = manifest.entryPoints.filter((p) => p.startsWith('jobs/')).length;
            diagnostics.push({ severity: 'info', message: `[webstir-backend] entries by bucket: server=${server} functions=${functionsCount} jobs=${jobsCount}` });
        } catch {
            // ignore
        }
        try {
            await persistAndDiffOutputs(options.workspaceRoot, paths.buildRoot, outputs, options.env ?? {}, diagnostics, mode);
        } catch {
            // ignore cache errors
        }
        try {
            await persistAndDiffManifest(options.workspaceRoot, moduleManifest, options.env ?? {}, diagnostics);
        } catch {
            // ignore cache errors
        }
        // Optionally filter diagnostics by severity for orchestrator consumption
        const minLevel = normalizeLogLevel(options.env?.WEBSTIR_BACKEND_LOG_LEVEL);
        const filteredDiagnostics = filterDiagnostics(manifest.diagnostics, minLevel);

        return {
            artifacts,
            manifest: {
                ...manifest,
                diagnostics: filteredDiagnostics
            }
        };
    },
    async getScaffoldAssets() {
        return await getScaffoldAssets();
    }
};

function normalizeMode(rawMode: unknown): 'build' | 'publish' | 'test' {
    if (typeof rawMode !== 'string') {
        return 'build';
    }
    const normalized = rawMode.toLowerCase();
    if (normalized === 'publish' || normalized === 'test') {
        return normalized;
    }
    return 'build';
}

async function collectArtifacts(buildRoot: string): Promise<ModuleArtifact[]> {
    const matches = await glob('**/*.js', {
        cwd: buildRoot,
        nodir: true,
        dot: false
    });

    return matches.map<ModuleArtifact>((relativePath) => ({
        path: path.join(buildRoot, relativePath),
        type: 'bundle'
    }));
}

async function loadWorkspaceModuleManifest(
    workspaceRoot: string,
    buildRoot: string,
    entryPoints: readonly string[],
    diagnostics: ModuleDiagnostic[]
): Promise<ModuleManifest> {
    const pkgPath = path.join(workspaceRoot, 'package.json');
    let workspacePackage: WorkspacePackageJson | undefined;

    try {
        const raw = await readFile(pkgPath, 'utf8');
        workspacePackage = JSON.parse(raw) as WorkspacePackageJson;
    } catch (error) {
        diagnostics.push({
            severity: 'warn',
            message: `[webstir-backend] unable to read ${pkgPath}: ${(error as Error).message}. Using defaults.`
        });
    }

    const moduleConfig = workspacePackage?.webstir?.module ?? {};

    let manifestCandidate: ModuleManifest = {
        contractVersion: typeof moduleConfig.contractVersion === 'string' ? moduleConfig.contractVersion : CONTRACT_VERSION,
        name: typeof moduleConfig.name === 'string' ? moduleConfig.name : deriveModuleName(workspacePackage, workspaceRoot),
        version: typeof moduleConfig.version === 'string' ? moduleConfig.version : deriveModuleVersion(workspacePackage),
        kind: 'backend',
        capabilities: Array.isArray(moduleConfig.capabilities) ? moduleConfig.capabilities : [],
        routes: moduleConfig.routes ?? [],
        views: moduleConfig.views ?? [],
        jobs: moduleConfig.jobs ?? [],
        events: moduleConfig.events ?? [],
        services: moduleConfig.services ?? [],
        init: moduleConfig.init,
        dispose: moduleConfig.dispose
    };

    const definition = await loadModuleDefinition(buildRoot, diagnostics);
    if (definition) {
        const definitionManifest = definition.manifest ?? ({} as ModuleManifest);
        const routesFromDefinition = definition.routes?.map((route) => route.definition);
        const viewsFromDefinition = definition.views?.map((view) => view.definition);

        const mergedCapabilities = Array.from(
            new Set([...(manifestCandidate.capabilities ?? []), ...(definitionManifest.capabilities ?? [])])
        );

        manifestCandidate = {
            ...manifestCandidate,
            ...definitionManifest,
            capabilities: mergedCapabilities,
            routes: routesFromDefinition ?? definitionManifest.routes ?? manifestCandidate.routes ?? [],
            views: viewsFromDefinition ?? definitionManifest.views ?? manifestCandidate.views ?? [],
            jobs: definitionManifest.jobs ?? manifestCandidate.jobs ?? [],
            events: definitionManifest.events ?? manifestCandidate.events ?? [],
            services: definitionManifest.services ?? manifestCandidate.services ?? [],
            init: definitionManifest.init ?? manifestCandidate.init,
            dispose: definitionManifest.dispose ?? manifestCandidate.dispose
        };
    }

    const validation = moduleManifestSchema.safeParse(manifestCandidate);
    if (!validation.success) {
        const problems = validation.error.issues
            .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
            .join('; ');
        diagnostics.push({
            severity: 'error',
            message: `[webstir-backend] module manifest validation failed (${problems}). Falling back to defaults.`
        });
        return {
            contractVersion: CONTRACT_VERSION,
            name: deriveModuleName(workspacePackage, workspaceRoot),
            version: deriveModuleVersion(workspacePackage),
            kind: 'backend',
            capabilities: [],
            routes: [],
            views: [],
            jobs: [],
            events: [],
            services: []
        };
    }

    const manifest = validation.data;

    // Duplicate route detection (method+path), with basic path normalization
    try {
        const normalizePath = (p: unknown) => {
            let s = typeof p === 'string' ? p : '';
            if (!s.startsWith('/')) s = '/' + s;
            s = s.replace(/\/+/, '/');
            if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
            return s;
        };
        const seen = new Map<string, number>();
        for (const r of manifest.routes ?? []) {
            const method = typeof (r as any).method === 'string' ? (r as any).method.toUpperCase() : '';
            const pathKey = normalizePath((r as any).path);
            const key = `${method} ${pathKey}`;
            seen.set(key, (seen.get(key) ?? 0) + 1);
        }
        const dups = Array.from(seen.entries()).filter(([, count]) => count > 1);
        if (dups.length > 0) {
            const list = dups.map(([k, c]) => `${k} (${c}x)`).join(', ');
            diagnostics.push({ severity: 'warn', message: `[webstir-backend] duplicate route definitions: ${list}` });
        }
    } catch {
        // best-effort only
    }

    if (manifest.routes?.length && entryPoints.length === 0) {
        diagnostics.push({
            severity: 'warn',
            message: '[webstir-backend] module manifest defines routes but no entry points were built. Ensure backend compilation produced handlers.'
        });
    }

    // Jobs/Events/Services counts and soft hints
    try {
        const jobs = Array.isArray(manifest.jobs) ? manifest.jobs : [];
        const events = Array.isArray(manifest.events) ? manifest.events : [];
        const services = Array.isArray(manifest.services) ? manifest.services : [];
        if (jobs.length + events.length + services.length > 0) {
            diagnostics.push({
                severity: 'info',
                message: `[webstir-backend] manifest jobs=${jobs.length} events=${events.length} services=${services.length}`
            });
        }

        // Warn if any job lacks a schedule (advisory; schedule is optional by schema)
        const noSchedule = jobs.filter((j: any) => j && typeof j.name === 'string' && (j.schedule === undefined || j.schedule === null));
        if (noSchedule.length > 0) {
            const MAX_LIST = 10;
            const names = noSchedule.map((j: any) => j.name).slice(0, MAX_LIST).join(', ');
            const omitted = noSchedule.length > MAX_LIST ? ` (+${noSchedule.length - MAX_LIST} more)` : '';
            diagnostics.push({
                severity: 'warn',
                message: `[webstir-backend] jobs without schedules: ${names}${omitted}`
            });
        }
    } catch {
        // best-effort only
    }

    // Quick manifest summary
    try {
        const routes = Array.isArray(manifest.routes) ? manifest.routes.length : 0;
        const views = Array.isArray(manifest.views) ? manifest.views.length : 0;
        const caps = Array.isArray(manifest.capabilities) && manifest.capabilities.length > 0 ? ` [${manifest.capabilities.join(', ')}]` : '';
        diagnostics.push({ severity: 'info', message: `[webstir-backend] manifest routes=${routes} views=${views}${caps}` });
    } catch {
        // ignore
    }

    return manifest;
}

async function loadModuleDefinition(
    buildRoot: string,
    diagnostics: ModuleDiagnostic[]
): Promise<ModuleDefinition | undefined> {
    const candidates = [
        path.join(buildRoot, 'module.js'),
        path.join(buildRoot, 'module.mjs'),
        path.join(buildRoot, 'module/index.js'),
        path.join(buildRoot, 'module/index.mjs')
    ];

    for (const fullPath of candidates) {
        if (!existsSync(fullPath)) {
            continue;
        }

        try {
            const moduleUrl = `${pathToFileURL(fullPath).href}?t=${Date.now()}`;
            const imported = (await import(moduleUrl)) as Record<string, unknown>;
            const definitionCandidate = extractModuleDefinition(imported);
            if (isModuleDefinition(definitionCandidate)) {
                return definitionCandidate;
            }
            diagnostics.push({
                severity: 'warn',
                message: `[webstir-backend] module definition at ${fullPath} does not export a createModule() definition.`
            });
        } catch (error) {
            diagnostics.push({
                severity: 'warn',
                message: `[webstir-backend] failed to load module definition from ${fullPath}: ${(error as Error).message}`
            });
        }
    }

    return undefined;
}

function extractModuleDefinition(exports: Record<string, unknown>): unknown {
    const keys = ['module', 'moduleDefinition', 'default', 'backendModule'];
    for (const key of keys) {
        if (key in exports) {
            const value = exports[key as keyof typeof exports];
            if (value !== null && value !== undefined) {
                return value;
            }
        }
    }
    return undefined;
}

function isModuleDefinition(value: unknown): value is ModuleDefinition {
    return typeof value === 'object' && value !== null && 'manifest' in (value as Record<string, unknown>);
}

function createManifest(
    buildRoot: string,
    artifacts: readonly ModuleArtifact[],
    diagnostics: ModuleDiagnostic[],
    moduleManifest: ModuleManifest
) {
    const entryPoints: string[] = [];

    for (const artifact of artifacts) {
        const relative = path.relative(buildRoot, artifact.path);
        if (relative.endsWith('index.js')) {
            entryPoints.push(relative);
        }
    }

    if (entryPoints.length === 0) {
        const defaultEntry = path.join(buildRoot, 'index.js');
        if (existsSync(defaultEntry)) {
            entryPoints.push(path.relative(buildRoot, defaultEntry));
        } else {
            diagnostics.push({
                severity: 'warn',
                message: 'No backend entry point found (expected index.js).'
            });
        }
    }

    return {
        entryPoints,
        staticAssets: [],
        diagnostics,
        module: moduleManifest
    };
}

async function runTypeCheck(tsconfigPath: string, env: Record<string, string | undefined>, diagnostics: ModuleDiagnostic[]): Promise<void> {
    if (!existsSync(tsconfigPath)) {
        diagnostics.push({
            severity: 'warn',
            message: `TypeScript config not found at ${tsconfigPath}; skipping type-check.`
        });
        return;
    }

    await new Promise<void>((resolve, reject) => {
        const child = spawn('tsc', ['-p', tsconfigPath, '--noEmit'], {
            stdio: 'pipe',
            env: {
                ...process.env,
                ...env
            }
        });

        let stdout = '';
        let stderr = '';

        child.stdout?.on('data', (chunk) => {
            stdout += chunk.toString();
        });

        child.stderr?.on('data', (chunk) => {
            stderr += chunk.toString();
        });

        child.on('error', (err: any) => {
            const code = (err && typeof err === 'object') ? (err.code as string | undefined) : undefined;
            if (code === 'ENOENT') {
                diagnostics.push({ severity: 'warn', message: 'TypeScript compiler (tsc) not found in PATH; skipping type-check.' });
                resolve();
                return;
            }
            reject(err);
        });
        child.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                diagnostics.push({
                    severity: 'error',
                    message: `Type checking failed (exit code ${code}).`,
                    file: tsconfigPath
                });
                if (stderr.trim()) {
                    diagnostics.push({ severity: 'error', message: stderr.trim() });
                }
                if (stdout.trim()) {
                    diagnostics.push({ severity: 'info', message: stdout.trim() });
                }
                reject(new Error('Type checking failed.'));
            }
        });
    });
}

function deriveModuleName(pkg: WorkspacePackageJson | undefined, workspaceRoot: string): string {
    if (typeof pkg?.webstir?.module?.name === 'string' && pkg.webstir.module.name.length > 0) {
        return pkg.webstir.module.name;
    }
    if (typeof pkg?.name === 'string' && pkg.name.length > 0) {
        return pkg.name;
    }
    return `backend-module-${path.basename(workspaceRoot)}`;
}

function deriveModuleVersion(pkg: WorkspacePackageJson | undefined): string {
    if (typeof pkg?.webstir?.module?.version === 'string' && pkg.webstir.module.version.length > 0) {
        return pkg.webstir.module.version;
    }
    if (typeof pkg?.version === 'string' && pkg.version.length > 0) {
        return pkg.version;
    }
    return '0.0.0';
}

function shouldTypeCheck(mode: 'build' | 'publish' | 'test', env: Record<string, string | undefined>): boolean {
    if (mode === 'publish') {
        return true;
    }
    const flag = env?.WEBSTIR_BACKEND_TYPECHECK;
    if (typeof flag === 'string' && flag.toLowerCase() === 'skip') {
        return false;
    }
    return true;
}

type Severity = 'info' | 'warn' | 'error';

function normalizeLogLevel(value: unknown): Severity {
    if (typeof value !== 'string') return 'info';
    const v = value.toLowerCase();
    if (v === 'error' || v === 'warn' || v === 'info') return v;
    return 'info';
}

function filterDiagnostics(list: readonly ModuleDiagnostic[], min: Severity): readonly ModuleDiagnostic[] {
    const rank = (s: Severity) => (s === 'error' ? 3 : s === 'warn' ? 2 : 1);
    const threshold = rank(min);
    return list.filter((d) => rank(d.severity as Severity) >= threshold);
}

interface BuildOptions {
    readonly sourceRoot: string;
    readonly buildRoot: string;
    readonly tsconfigPath: string;
    readonly mode: 'build' | 'publish' | 'test';
    readonly env: Record<string, string | undefined>;
    readonly incremental: boolean;
    readonly diagnostics: ModuleDiagnostic[];
    readonly entryPoints: readonly string[];
}

async function runEsbuild(options: BuildOptions): Promise<Record<string, number> | undefined> {
    const { sourceRoot, buildRoot, tsconfigPath, mode, env, diagnostics, entryPoints } = options;
    const isProduction = mode === 'publish';
    const useIncremental = !isProduction && options.incremental === true;
    const incrementalKey = useIncremental ? createIncrementalKey(mode, buildRoot) : undefined;

    if (!entryPoints || entryPoints.length === 0) {
        if (incrementalKey) {
            await disposeIncrementalBuild(incrementalKey);
        }
        return undefined;
    }

    const entrySignature = useIncremental ? createEntrySignature(entryPoints) : undefined;
    const nodeEnv = env?.NODE_ENV ?? (isProduction ? 'production' : 'development');
    const diagMax = (() => {
        const raw = env?.WEBSTIR_BACKEND_DIAG_MAX;
        const n = typeof raw === 'string' ? parseInt(raw, 10) : NaN;
        return Number.isFinite(n) && n > 0 ? n : 50;
    })();

    const define: Record<string, string> = {
        'process.env.NODE_ENV': JSON.stringify(nodeEnv)
    };

    const start = performance.now();
    try {
        const MAX_PRINT = 50;
        let reusedIncremental = false;
        let result: Awaited<ReturnType<typeof esbuild>>;

        if (isProduction) {
            if (incrementalKey) {
                await disposeIncrementalBuild(incrementalKey);
            }
            result = await esbuild({
                entryPoints: entryPoints as string[],
                bundle: true,
                packages: 'external',
                platform: 'node',
                target: 'node20',
                format: 'esm',
                minify: true,
                sourcemap: false,
                legalComments: 'none',
                outdir: buildRoot,
                outbase: sourceRoot,
                entryNames: '[dir]/[name]',
                tsconfig: existsSync(tsconfigPath) ? tsconfigPath : undefined,
                define,
                logLevel: 'silent',
                metafile: true
            });
        } else if (useIncremental && incrementalKey && entrySignature) {
            const cached = incrementalBuildCache.get(incrementalKey);
            if (cached && cached.entrySignature === entrySignature) {
                reusedIncremental = true;
                result = await cached.context.rebuild();
            } else {
                if (cached) {
                    await disposeIncrementalBuild(incrementalKey);
                }
                const ctx = await esbuildContext({
                    entryPoints: entryPoints as string[],
                    bundle: false,
                    platform: 'node',
                    target: 'node20',
                    format: 'esm',
                    sourcemap: true,
                    outdir: buildRoot,
                    outbase: sourceRoot,
                    tsconfig: existsSync(tsconfigPath) ? tsconfigPath : undefined,
                    define,
                    logLevel: 'silent',
                    metafile: true
                });
                incrementalBuildCache.set(incrementalKey, {
                    entrySignature,
                    context: ctx
                });
                result = await ctx.rebuild();
            }
        } else {
            if (incrementalKey) {
                await disposeIncrementalBuild(incrementalKey);
            }
            result = await esbuild({
                entryPoints: entryPoints as string[],
                bundle: false,
                platform: 'node',
                target: 'node20',
                format: 'esm',
                sourcemap: true,
                outdir: buildRoot,
                outbase: sourceRoot,
                tsconfig: existsSync(tsconfigPath) ? tsconfigPath : undefined,
                define,
                logLevel: 'silent',
                metafile: true
            });
        }

        const warnCount = result.warnings?.length ?? 0;
        for (const w of (result.warnings ?? []).slice(0, diagMax)) {
            diagnostics.push({ severity: 'warn', message: formatEsbuildMessage(w) });
        }
        if (warnCount > diagMax) {
            diagnostics.push({
                severity: 'info',
                message: `[webstir-backend] ${isProduction ? 'publish:esbuild' : `${mode}:esbuild`} ... ${warnCount - diagMax} more warning(s) omitted`
            });
        }
        const end = performance.now();
        const reuseSuffix = reusedIncremental ? ' (incremental)' : '';
        diagnostics.push({
            severity: 'info',
            message: `[webstir-backend] ${isProduction ? 'publish:esbuild' : `${mode}:esbuild`} 0 error(s), ${warnCount} warning(s) in ${(end - start).toFixed(1)}ms${reuseSuffix}`
        });

        return collectOutputSizes((result as any).metafile, buildRoot);
    } catch (error) {
        const end = performance.now();
        if (incrementalKey) {
            await disposeIncrementalBuild(incrementalKey);
        }
        if (isEsbuildFailure(error)) {
            const errs = error.errors ?? [];
            const warns = error.warnings ?? [];
            for (const e of errs.slice(0, diagMax)) {
                diagnostics.push({ severity: 'error', message: formatEsbuildMessage(e) });
            }
            for (const w of warns.slice(0, diagMax)) {
                diagnostics.push({ severity: 'warn', message: formatEsbuildMessage(w) });
            }
            if (errs.length > diagMax) {
                diagnostics.push({ severity: 'info', message: `[webstir-backend] ${mode}:esbuild ... ${errs.length - diagMax} more error(s) omitted` });
            }
            if (warns.length > diagMax) {
                diagnostics.push({ severity: 'info', message: `[webstir-backend] ${mode}:esbuild ... ${warns.length - diagMax} more warning(s) omitted` });
            }
            diagnostics.push({ severity: 'info', message: `[webstir-backend] ${mode}:esbuild ${errs.length} error(s), ${warns.length} warning(s) in ${(end - start).toFixed(1)}ms` });
        } else if (error instanceof Error) {
            diagnostics.push({ severity: 'error', message: error.message });
        } else {
            diagnostics.push({ severity: 'error', message: String(error) });
        }
        throw new Error('esbuild failed.');
    }
}

function createIncrementalKey(mode: 'build' | 'publish' | 'test', buildRoot: string): string {
    return `${mode}:${path.resolve(buildRoot)}`;
}

async function disposeIncrementalBuild(key: string): Promise<void> {
    const cached = incrementalBuildCache.get(key);
    if (cached) {
        try {
            await cached.context.dispose();
        } catch {
            // ignore
        }
        incrementalBuildCache.delete(key);
    }
}

function clearIncrementalCache(): void {
    for (const [key, entry] of incrementalBuildCache.entries()) {
        try {
            entry.context.dispose();
        } catch {
            // ignore
        }
        incrementalBuildCache.delete(key);
    }
}

function createEntrySignature(entryPoints: readonly string[]): string {
    return Array.from(entryPoints).sort().join('|');
}

function collectOutputSizes(metafile: unknown, buildRoot: string): Record<string, number> {
    const outputs: Record<string, number> = {};
    if (!metafile || typeof metafile !== 'object') {
        return outputs;
    }
    const mf = metafile as { outputs?: Record<string, { bytes?: number }> };
    for (const [outPath, info] of Object.entries(mf.outputs ?? {})) {
        const rel = path.relative(buildRoot, outPath);
        outputs[rel] = typeof info.bytes === 'number' ? info.bytes : 0;
    }
    return outputs;
}

async function discoverEntryPoints(sourceRoot: string): Promise<string[]> {
    const patterns = [
        'index.{ts,tsx,js,mjs}',
        'functions/*/index.{ts,tsx,js,mjs}',
        'jobs/*/index.{ts,tsx,js,mjs}'
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

async function discoverModuleDefinitionSource(sourceRoot: string): Promise<string | undefined> {
    const patterns = [
        'module.{ts,tsx,js,mjs}',
        'module/index.{ts,tsx,js,mjs}'
    ];

    for (const pattern of patterns) {
        const matches = await glob(pattern, {
            cwd: sourceRoot,
            absolute: true,
            nodir: true,
            dot: false
        });

        if (matches.length > 0) {
            return matches[0];
        }
    }

    return undefined;
}

interface ModuleDefinitionBuildOptions {
    readonly sourceFile: string;
    readonly sourceRoot: string;
    readonly buildRoot: string;
    readonly tsconfigPath: string;
    readonly mode: 'build' | 'publish' | 'test';
    readonly env?: Record<string, string | undefined>;
    readonly diagnostics: ModuleDiagnostic[];
}

async function buildModuleDefinition(options: ModuleDefinitionBuildOptions): Promise<void> {
    const { sourceFile, sourceRoot, buildRoot, tsconfigPath, mode, env, diagnostics } = options;

    const isProduction = mode === 'publish';
    const nodeEnv = env?.NODE_ENV ?? (isProduction ? 'production' : 'development');
    const define: Record<string, string> = {
        'process.env.NODE_ENV': JSON.stringify(nodeEnv)
    };

    try {
        await esbuild({
            entryPoints: [sourceFile],
            bundle: false,
            platform: 'node',
            target: 'node20',
            format: 'esm',
            sourcemap: !isProduction,
            outdir: buildRoot,
            outbase: sourceRoot,
            entryNames: '[dir]/[name]',
            tsconfig: existsSync(tsconfigPath) ? tsconfigPath : undefined,
            define,
            logLevel: 'silent'
        });
    } catch (error) {
        if (isEsbuildFailure(error)) {
            for (const e of error.errors ?? []) {
                diagnostics.push({ severity: 'error', message: formatEsbuildMessage(e) });
            }
            for (const w of error.warnings ?? []) {
                diagnostics.push({ severity: 'warn', message: formatEsbuildMessage(w) });
            }
        } else if (error instanceof Error) {
            diagnostics.push({ severity: 'error', message: error.message });
        } else {
            diagnostics.push({ severity: 'error', message: String(error) });
        }
    }
}

function isEsbuildFailure(error: unknown): error is { errors?: readonly any[]; warnings?: readonly any[] } {
    return typeof error === 'object' && error !== null && ('errors' in (error as any) || 'warnings' in (error as any));
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

async function persistAndDiffOutputs(
    workspaceRoot: string,
    buildRoot: string,
    outputs: Record<string, number> | undefined,
    env: Record<string, string | undefined>,
    diagnostics: ModuleDiagnostic[],
    mode: 'build' | 'publish' | 'test'
): Promise<void> {
    if (!outputs) return;
    try {
        const diagMax = (() => {
            const raw = env?.WEBSTIR_BACKEND_DIAG_MAX;
            const n = typeof raw === 'string' ? parseInt(raw, 10) : NaN;
            return Number.isFinite(n) && n > 0 ? n : 50;
        })();
        const webstirDir = path.join(workspaceRoot, '.webstir');
        const cachePath = path.join(webstirDir, 'backend-outputs.json');
        await mkdir(webstirDir, { recursive: true });

        let previous: Record<string, number> = {};
        try {
            const raw = await readFile(cachePath, 'utf8');
            previous = JSON.parse(raw) as Record<string, number>;
        } catch {
            // first run or unreadable cache
        }

        const changed: string[] = [];
        for (const [rel, bytes] of Object.entries(outputs)) {
            if (previous[rel] !== bytes) {
                changed.push(rel);
            }
        }
        // Consider deletions as changes too
        const removed = Object.keys(previous).filter((rel) => outputs[rel] === undefined);

        if (changed.length + removed.length > 0) {
            const list = changed.slice(0, diagMax).join(', ');
            const omitted = changed.length > diagMax ? ` (+${changed.length - diagMax} more)` : '';
            const removedInfo = removed.length > 0 ? `, removed=${removed.length}` : '';
            diagnostics.push({
                severity: 'info',
                message: `[webstir-backend] ${mode}:changed ${changed.length} file(s): ${list}${omitted}${removedInfo}`
            });
        }

        await writeFile(cachePath, JSON.stringify(outputs, null, 2), 'utf8');
    } catch {
        // ignore cache errors
    }
}

async function persistAndDiffManifest(
    workspaceRoot: string,
    manifest: ModuleManifest,
    env: Record<string, string | undefined>,
    diagnostics: ModuleDiagnostic[]
): Promise<void> {
    try {
        const diagMax = (() => {
            const raw = env?.WEBSTIR_BACKEND_DIAG_MAX;
            const n = typeof raw === 'string' ? parseInt(raw, 10) : NaN;
            return Number.isFinite(n) && n > 0 ? n : 50;
        })();
        const webstirDir = path.join(workspaceRoot, '.webstir');
        const cachePath = path.join(webstirDir, 'backend-manifest-digest.json');
        await mkdir(webstirDir, { recursive: true });

        const routeKeys = Array.isArray(manifest.routes)
            ? (manifest.routes as any[]).map((r) => `${(r.method ?? '').toUpperCase()} ${r.path ?? ''}`)
            : [];
        const viewPaths = Array.isArray(manifest.views)
            ? (manifest.views as any[]).map((v) => `${v.path ?? ''}`)
            : [];
        const caps = Array.isArray(manifest.capabilities) ? manifest.capabilities : [];

        type Digest = { routes: string[]; views: string[]; capabilities: string[] };
        let previous: Digest | undefined;
        try {
            const raw = await readFile(cachePath, 'utf8');
            previous = JSON.parse(raw) as Digest;
        } catch {
            // first run; no diff
        }

        if (previous) {
            const prevRoutes = new Set(previous.routes);
            const prevViews = new Set(previous.views);
            const nextRoutes = new Set(routeKeys);
            const nextViews = new Set(viewPaths);

            const addedRoutes: string[] = [];
            const removedRoutes: string[] = [];
            const addedViews: string[] = [];
            const removedViews: string[] = [];

            for (const r of nextRoutes) if (!prevRoutes.has(r)) addedRoutes.push(r);
            for (const r of prevRoutes) if (!nextRoutes.has(r)) removedRoutes.push(r);
            for (const v of nextViews) if (!prevViews.has(v)) addedViews.push(v);
            for (const v of prevViews) if (!nextViews.has(v)) removedViews.push(v);

            if (addedRoutes.length + removedRoutes.length + addedViews.length + removedViews.length > 0) {
                const list = (items: string[]) => items.slice(0, diagMax).join(', ');
                const routeDelta = `routes +${addedRoutes.length}/-${removedRoutes.length}`;
                const viewDelta = `views +${addedViews.length}/-${removedViews.length}`;
                let msg = `[webstir-backend] manifest changed: ${routeDelta}; ${viewDelta}`;
                const details: string[] = [];
                if (addedRoutes.length > 0) details.push(`added routes: ${list(addedRoutes)}`);
                if (removedRoutes.length > 0) details.push(`removed routes: ${list(removedRoutes)}`);
                if (addedViews.length > 0) details.push(`added views: ${list(addedViews)}`);
                if (removedViews.length > 0) details.push(`removed views: ${list(removedViews)}`);
                if (details.length > 0) {
                    msg += ` — ${details.join(' | ')}`;
                }
                diagnostics.push({ severity: 'info', message: msg });
            }
        }

        const digest: Digest = { routes: routeKeys, views: viewPaths, capabilities: caps };
        await writeFile(cachePath, JSON.stringify(digest, null, 2), 'utf8');
    } catch {
        // ignore cache errors
    }
}

async function getScaffoldAssets(): Promise<readonly ModuleAsset[]> {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const packageRoot = path.resolve(here, '..');
    const templatesRoot = path.join(packageRoot, 'templates', 'backend');

    return [
        {
            sourcePath: path.join(templatesRoot, 'tsconfig.json'),
            targetPath: path.join('src', 'backend', 'tsconfig.json')
        },
        {
            sourcePath: path.join(templatesRoot, 'index.ts'),
            targetPath: path.join('src', 'backend', 'index.ts')
        },
        {
            sourcePath: path.join(templatesRoot, 'server', 'fastify.ts'),
            targetPath: path.join('src', 'backend', 'server', 'fastify.ts')
        },
        {
            sourcePath: path.join(templatesRoot, 'functions', 'hello', 'index.ts'),
            targetPath: path.join('src', 'backend', 'functions', 'hello', 'index.ts')
        },
        {
            sourcePath: path.join(templatesRoot, 'jobs', 'nightly', 'index.ts'),
            targetPath: path.join('src', 'backend', 'jobs', 'nightly', 'index.ts')
        }
    ];
}
