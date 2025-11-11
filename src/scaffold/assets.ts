import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ModuleAsset } from '@webstir-io/module-contract';

export async function getBackendScaffoldAssets(): Promise<readonly ModuleAsset[]> {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const packageRoot = path.resolve(here, '..', '..');
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
            sourcePath: path.join(templatesRoot, 'module.ts'),
            targetPath: path.join('src', 'backend', 'module.ts')
        },
        {
            sourcePath: path.join(templatesRoot, 'env.ts'),
            targetPath: path.join('src', 'backend', 'env.ts')
        },
        {
            sourcePath: path.join(templatesRoot, 'functions', 'hello', 'index.ts'),
            targetPath: path.join('src', 'backend', 'functions', 'hello', 'index.ts')
        },
        {
            sourcePath: path.join(templatesRoot, 'jobs', 'nightly', 'index.ts'),
            targetPath: path.join('src', 'backend', 'jobs', 'nightly', 'index.ts')
        },
        {
            sourcePath: path.join(templatesRoot, '.env.example'),
            targetPath: path.join('.env.example')
        }
    ];
}
