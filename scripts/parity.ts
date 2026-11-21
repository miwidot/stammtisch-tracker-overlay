/**
 * Parity check between our producer output and what tarkovtracker.org serves.
 *
 *   npm run parity -- fetch-live --out <dir>
 *   npm run parity -- compare --live <dir> --catalogs <data dir> --overlay dist/overlay.json \
 *     --report parity.md --json parity.json
 *
 * Only the public, documented `/api/tarkov/*` GET endpoints are requested, one at a time, with a
 * pause between requests and an honest User-Agent. A 403/429 stops the run; nothing tries to get
 * around bot protection.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { runDirectly, sleep } from '../src/lib/script-utils.js';
import { CatalogDir } from './parity/catalogs.js';
import {
  LANGS,
  MODES,
  MODE_DATASETS,
  compareEndpoint,
  compareTaskNames,
  groupDifferences,
  type EndpointResult,
  type NameMismatch,
} from './parity/compare.js';
import {
  SYNTHESISED_META_PATHS,
  VOLATILE_PATHS,
  decodeBody,
  volatileClass,
  type Json,
} from './parity/normalize.js';

const BASE = 'https://tarkovtracker.org';
const USER_AGENT = 'stammtisch-overlay-parity-check/1 (read-only, sequential)';
const PAUSE_MS = 250;
const TIMEOUT_MS = 180_000;
/** Datasets requested in every language; the rest only in English (they are language-neutral). */
const PER_LANG = ['tasks-core', 'tasks-objectives', 'items-lite', 'hideout'];

export interface PlannedRequest {
  file: string;
  path: string;
}

function fileName(dataset: string): string {
  return dataset.replace('?view=', '.');
}

export function planRequests(): PlannedRequest[] {
  const plan: PlannedRequest[] = [];
  for (const mode of MODES) {
    for (const lang of LANGS) {
      for (const dataset of MODE_DATASETS) {
        if (lang !== 'en' && !PER_LANG.includes(dataset)) continue;
        const sep = dataset.includes('?') ? '&' : '?';
        plan.push({
          file: join(mode, lang, `${fileName(dataset)}.json`),
          path: `/api/tarkov/${dataset}${sep}gameMode=${mode}&lang=${lang}`,
        });
      }
    }
  }
  for (const lang of LANGS) {
    plan.push({ file: join('strings', `${lang}.json`), path: `/api/tarkov/strings?lang=${lang}` });
  }
  plan.push({ file: 'extract-requirements.json', path: '/api/tarkov/extract-requirements' });
  return plan;
}

interface RequestLog {
  path: string;
  status: number;
  fetchedAt: string;
  bytes: number;
  headers: Record<string, string>;
}

const KEPT_HEADERS = [
  'x-overlay-version',
  'x-overlay-generated',
  'x-overlay-sha256',
  'x-overlay-status',
  'x-catalog-release',
  'x-cache-status',
  'content-type',
];

async function fetchLive(out: string, base: string): Promise<void> {
  const log: RequestLog[] = [];
  for (const item of planRequests()) {
    const response = await fetch(`${base}${item.path}`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = Buffer.from(await response.arrayBuffer());
    const headers = Object.fromEntries(
      KEPT_HEADERS.flatMap((name) => {
        const value = response.headers.get(name);
        return value === null ? [] : [[name, value]];
      })
    );
    log.push({
      path: item.path,
      status: response.status,
      fetchedAt: new Date().toISOString(),
      bytes: body.length,
      headers,
    });
    if (response.status === 403 || response.status === 429) {
      writeFileSync(join(out, '_requests.json'), JSON.stringify(log, null, 2));
      throw new Error(
        `${item.path} answered ${response.status}; stopping, not attempting to get around it`
      );
    }
    if (!response.ok) {
      console.error(`[parity] ${item.path} -> ${response.status}`);
    } else {
      const target = join(out, item.file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, body);
      console.error(`[parity] ${item.path} -> ${response.status} ${body.length} bytes`);
    }
    await sleep(PAUSE_MS);
  }
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, '_requests.json'), JSON.stringify(log, null, 2));
}

function readIf(path: string): Buffer | undefined {
  return existsSync(path) ? readFileSync(path) : undefined;
}

function parseStrings(bytes: Buffer | undefined): Record<string, string> {
  if (!bytes) return {};
  const body = JSON.parse(decodeBody(bytes).toString('utf8')) as {
    data?: { strings?: Record<string, string> };
  };
  return body.data?.strings ?? {};
}

function extractRequirementsOurs(overlayPath: string): Buffer {
  const overlay = JSON.parse(readFileSync(overlayPath, 'utf8')) as Record<string, Json>;
  return Buffer.from(
    JSON.stringify({
      data: { requirements: overlay.extractRequirements, cues: overlay.extractCues },
      dataOverlay: overlay.$meta,
    })
  );
}

interface NameCheck {
  label: string;
  checked: number;
  mismatches: NameMismatch[];
}

export interface ParityReport {
  generatedAt: string;
  results: EndpointResult[];
  names: NameCheck[];
}

const BUILD_IDENTITY = ['dataOverlay.generated', 'dataOverlay.sha256'];

function compareAll(
  liveDir: string,
  catalogs: CatalogDir,
  overlayPath: string,
  strictBuild: boolean
): ParityReport {
  const base = strictBuild
    ? VOLATILE_PATHS.filter((path) => !BUILD_IDENTITY.includes(path))
    : VOLATILE_PATHS;
  const results: EndpointResult[] = [];
  for (const item of planRequests()) {
    const live = readIf(join(liveDir, item.file));
    const label = item.file.replace(/\.json$/, '');
    const [first, second, third] = label.split('/');
    let ours: Buffer | undefined;
    if (first === 'strings') ours = catalogs.scope(`strings/${second}`);
    else if (first === 'extract-requirements') ours = extractRequirementsOurs(overlayPath);
    else if (third === 'tasks-import') ours = catalogs.taskImport(first!);
    else if (third?.endsWith('.counts')) ours = catalogs.scope(`tasks-objectives/${first}/counts`);
    else ours = catalogs.scope(`${third}/${first}`);
    const paths = first === 'extract-requirements' ? [...base, ...SYNTHESISED_META_PATHS] : base;
    results.push(compareEndpoint(label, live, ours, 200, paths));
  }
  const names: NameCheck[] = [];
  for (const mode of MODES) {
    for (const lang of LANGS) {
      const liveCore = readIf(join(liveDir, mode, lang, 'tasks-core.json'));
      const oursCore = catalogs.scope(`tasks-core/${mode}`);
      if (!liveCore || !oursCore) continue;
      const parseBody = (bytes: Buffer): Json =>
        JSON.parse(decodeBody(bytes).toString('utf8')) as Json;
      const result = compareTaskNames(
        parseBody(liveCore),
        parseBody(oursCore),
        parseStrings(readIf(join(liveDir, 'strings', `${lang}.json`))),
        parseStrings(catalogs.scope(`strings/${lang}`))
      );
      names.push({ label: `${mode}/${lang}`, ...result });
    }
  }
  return { generatedAt: new Date().toISOString(), results, names };
}

export function renderReport(report: ParityReport): string {
  const lines = ['# Parity report', '', `Generated ${report.generatedAt}`, ''];
  lines.push('| Endpoint | Verdict | Differences | Normalized classes |', '|---|---|---|---|');
  const applied = new Set<string>();
  for (const r of report.results) {
    r.normalized.forEach((path) => applied.add(path));
    const classes = [...new Set(r.normalized.map(volatileClass))].sort();
    lines.push(`| ${r.label} | ${r.verdict} | ${r.total} | ${classes.join(', ') || '-'} |`);
  }
  lines.push('', '## Normalized fields', '', '| Class | Field |', '|---|---|');
  for (const path of [...applied].sort()) lines.push(`| ${volatileClass(path)} | ${path} |`);
  lines.push(
    '',
    '## Resolved task names',
    '',
    '| Mode/lang | Checked | Mismatches |',
    '|---|---|---|'
  );
  for (const n of report.names)
    lines.push(`| ${n.label} | ${n.checked} | ${n.mismatches.length} |`);
  for (const r of report.results.filter((x) => x.verdict === 'DIFFERENT')) {
    lines.push('', `## ${r.label}`, '');
    for (const delta of r.idSets) {
      const liveOnly = delta.onlyLive.join(', ') || '-';
      const oursOnly = delta.onlyOurs.join(', ') || '-';
      lines.push(
        `- id set \`${delta.key}\`: live ${delta.live}, ours ${delta.ours}, only live ${liveOnly}, only ours ${oursOnly}`
      );
    }
    for (const [group, count] of groupDifferences(r.differences))
      lines.push(`- ${group}: ${count}`);
  }
  return `${lines.join('\n')}\n`;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      out: { type: 'string' },
      base: { type: 'string' },
      live: { type: 'string' },
      catalogs: { type: 'string' },
      overlay: { type: 'string' },
      report: { type: 'string' },
      json: { type: 'string' },
      'strict-build': { type: 'boolean' },
    },
  });
  if (command === 'fetch-live') {
    if (!values.out) throw new Error('fetch-live needs --out <dir>');
    mkdirSync(values.out, { recursive: true });
    await fetchLive(values.out, values.base ?? BASE);
    return;
  }
  if (command === 'compare') {
    if (!values.live || !values.catalogs || !values.overlay) {
      throw new Error('compare needs --live, --catalogs and --overlay');
    }
    const report = compareAll(
      values.live,
      new CatalogDir(values.catalogs),
      values.overlay,
      values['strict-build'] === true
    );
    if (values.json) writeFileSync(values.json, JSON.stringify(report, null, 2));
    const markdown = renderReport(report);
    if (values.report) writeFileSync(values.report, markdown);
    else process.stdout.write(markdown);
    if (report.results.some((r) => r.verdict === 'DIFFERENT' || r.verdict === 'MISSING')) {
      process.exitCode = 1;
    }
    return;
  }
  throw new Error('Usage: parity <fetch-live|compare> [options]');
}

runDirectly(import.meta.url, () => main());
