import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { keyToFileName, CATALOG_MANIFEST_FILE } from '../producer/lib.js';
import { decodeBody, type Json } from './normalize.js';

interface Manifest {
  completedAt: number;
  overlaySha: string;
  entries: Record<string, { key: string; bytes: number; headers: Record<string, string> }>;
}

/** Reads objects out of a producer output directory exactly the way the tracker's reader does. */
export class CatalogDir {
  readonly manifest: Manifest;
  constructor(private readonly dir: string) {
    const path = join(dir, keyToFileName(CATALOG_MANIFEST_FILE));
    if (!existsSync(path)) throw new Error(`No catalog manifest in ${dir}`);
    this.manifest = JSON.parse(readFileSync(path, 'utf8')) as Manifest;
  }

  private read(key: string): Buffer | undefined {
    const path = join(this.dir, keyToFileName(key));
    return existsSync(path) ? decodeBody(readFileSync(path)) : undefined;
  }

  /** Catalog scope such as `tasks-core/regular`, `tasks-objectives/pve/counts`, `strings/de`. */
  scope(scope: string): Buffer | undefined {
    const entry = this.manifest.entries[scope];
    return entry ? this.read(entry.key) : undefined;
  }

  /** English task-import snapshot; the HTTP endpoint serves its `payload`. */
  taskImport(mode: string): Buffer | undefined {
    const raw = this.read(`tasks-import-json-v1-en-${mode}`);
    if (!raw) return undefined;
    const snapshot = JSON.parse(raw.toString('utf8')) as { payload?: Json };
    return snapshot.payload === undefined
      ? undefined
      : Buffer.from(JSON.stringify(snapshot.payload));
  }
}
