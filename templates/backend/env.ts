import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AppEnv {
  NODE_ENV: string;
  PORT: number;
  API_BASE_URL: string;
}

const ENV_FILES = ['.env.local', '.env'];
const WORKSPACE_ROOT = resolveWorkspaceRoot();
let envLoaded = false;

export function loadEnv(): AppEnv {
  if (!envLoaded) {
    loadEnvFiles();
    envLoaded = true;
  }

  const NODE_ENV = process.env.NODE_ENV ?? 'development';
  const PORT = parsePort(process.env.PORT ?? '4000');
  const API_BASE_URL = requireEnv('API_BASE_URL', 'http://localhost:4000');

  return {
    NODE_ENV,
    PORT,
    API_BASE_URL
  };
}

function loadEnvFiles(): void {
  for (const file of ENV_FILES) {
    const full = path.resolve(WORKSPACE_ROOT, file);
    if (!existsSync(full)) continue;
    try {
      applyEnvFile(full);
    } catch (error) {
      console.warn(`[webstir-backend] failed to load ${file}: ${(error as Error).message}`);
    }
  }
}

function applyEnvFile(filePath: string): void {
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.trim().startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    if (!key || process.env[key] !== undefined) continue;
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function requireEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required env var ${name}`);
  }
  return value;
}

function parsePort(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 4000;
  }
  return parsed;
}

function resolveWorkspaceRoot(): string {
  if (process.env.WORKSPACE_ROOT) {
    return process.env.WORKSPACE_ROOT;
  }
  try {
    const filePath = fileURLToPath(import.meta.url);
    const dir = path.dirname(filePath);
    if (dir.endsWith(`${path.sep}src${path.sep}backend`)) {
      return path.resolve(dir, '..', '..');
    }
    if (dir.endsWith(`${path.sep}build${path.sep}backend`)) {
      return path.resolve(dir, '..', '..');
    }
  } catch {
    // ignore
  }
  return process.cwd();
}
