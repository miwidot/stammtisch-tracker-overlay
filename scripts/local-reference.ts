import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Resolve a capture without following an alias outside its selected store. */
export function resolveReferenceFile(file: string, directory: string): string {
  const capture = realpathSync(join(directory, file));
  const suffix = relative(realpathSync(directory), capture);
  if (suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    throw new Error('capture must remain within its reference directory');
  }
  return capture;
}

/** Capture inputs live only in the project's gitignored data/reference store. */
export function referenceDirectory(root = '.'): string {
  return join(root, 'data', 'reference');
}

/** CLI selections may narrow the capture store, never select another data root. */
export function resolveReferenceDirectory(directory: string, root = process.cwd()): string {
  const base = resolve(referenceDirectory(root));
  const selected = resolve(root, directory);
  const within = (parent: string, candidate: string): boolean => {
    const suffix = relative(parent, candidate);
    return suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
  };
  const refused = (): never => {
    throw new Error('reference directory must be under data/reference/');
  };
  if (!within(base, selected)) refused();
  if (existsSync(selected)) {
    const physicalBase = join(realpathSync(root), 'data', 'reference');
    if (!within(physicalBase, realpathSync(selected))) refused();
  }
  return selected;
}
