import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { lint, readConfig } from 'markdownlint/promise';

const excluded = new Set(['.git', 'node_modules', 'dist', 'data', 'eft']);
const files = [];
const directories = ['.'];
for (const directory of directories) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !excluded.has(entry.name)) directories.push(path);
    if (entry.isFile() && entry.name.endsWith('.md')) files.push(path);
  }
}
if (files.length === 0) throw new Error('No Markdown files found');

const config = await readConfig('.markdownlint.json');
const result = await lint({ config, files: files.sort() });
for (const [file, errors] of Object.entries(result)) {
  for (const error of errors) {
    const location = [file, error.lineNumber, error.errorRange?.[0]].filter(Boolean).join(':');
    console.error(
      `${location} ${error.ruleNames.join('/')} ${error.ruleDescription}${error.errorDetail ? ` [${error.errorDetail}]` : ''}`
    );
    process.exitCode = 1;
  }
}
