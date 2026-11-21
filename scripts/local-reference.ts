import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Whether `candidate` is `parent` or lies beneath it. */
function within(parent: string, candidate: string): boolean {
  const suffix = relative(parent, candidate);
  return suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

/** Resolve a capture without following an alias outside its selected store. */
export function resolveReferenceFile(file: string, directory: string): string {
  const capture = realpathSync(join(directory, file));
  if (!within(realpathSync(directory), capture)) {
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

/** The physical path of `path`'s nearest existing ancestor (or itself). */
function nearestExisting(path: string): string {
  let existing = path;
  while (!existsSync(existing)) existing = dirname(existing);
  return realpathSync(existing);
}

/**
 * Resolve a directory the tools will create or write under data/reference/.
 * Unlike a read selection, the target may not exist yet, so its nearest
 * existing ancestor must also resolve physically inside the store; otherwise a
 * symlinked parent could send new files outside it. A fresh checkout may have
 * no store yet: it is created only when its nearest existing ancestor is
 * physically inside the repository.
 */
export function resolveReferenceWriteDirectory(directory: string, root = process.cwd()): string {
  const selected = resolveReferenceDirectory(directory, root);
  const physicalRoot = realpathSync(root);
  const store = resolve(referenceDirectory(root));
  if (!existsSync(store)) {
    if (!within(physicalRoot, nearestExisting(store))) {
      throw new Error('reference store must stay inside the repository');
    }
    mkdirSync(store, { recursive: true });
  }
  const physicalBase = join(physicalRoot, 'data', 'reference');
  if (realpathSync(store) !== physicalBase || !within(physicalBase, nearestExisting(selected))) {
    throw new Error('reference write target must stay under data/reference/');
  }
  return selected;
}
