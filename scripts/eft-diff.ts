#!/usr/bin/env tsx
/**
 * Compare the quest definitions of two local references (decoded captures or
 * eft:remote snapshots): which quests appeared or disappeared, and which fields
 * changed, after dropping per-account progress fields.
 *
 * Use it to see what a client update changed, or to confirm that a live
 * remote-session snapshot still matches the latest capture before relying on
 * either.
 *
 * Usage:
 *   tsx scripts/eft-diff.ts [--mode pve|regular|pvp-season] [older.json newer.json] [--text] [--json out.json]
 *   npm run eft:diff -- --mode pvp-season
 *
 * Without files, it compares the two most recent references for --mode
 * (default pve). Both files must be under data/reference/. Localization changes
 * are summarized as a count unless --text is given.
 *
 * Exit codes: 0 when the comparison ran (regardless of differences); 1 when it
 * could not run.
 */

import { createHash } from 'crypto';
import { readFileSync, statSync, writeFileSync } from 'fs';
import { basename, dirname, relative } from 'path';

import {
  isDirectExecution,
  printHeader,
  printError,
  bold,
  dim,
  colors,
  type GameMode,
} from '../src/lib/index.js';
import { referenceDirectory, resolveReferenceDirectory } from './local-reference.js';
import {
  captureTimestamp,
  findQuestListFiles,
  modeFromReferenceFile,
  parseModeArgs,
  readQuestArray,
  referenceAppVersion,
} from './eft-compare.js';
import {
  canonicalQuestId,
  diffValues,
  loadSiblingLocale,
  questDefinition,
  questText,
  type ValueChange,
} from './lib/quest-definitions.js';

type Quest = Record<string, unknown>;

export interface Side {
  file: string;
  appVersion: string | null;
  quests: Map<string, Quest>;
  locale: Record<string, unknown>;
}

export interface QuestDiff {
  older: { file: string; appVersion: string | null; quests: number };
  newer: { file: string; appVersion: string | null; quests: number };
  added: Array<{ id: string; name?: string }>;
  removed: Array<{ id: string; name?: string }>;
  changed: Array<{
    id: string;
    name?: string;
    changes: ValueChange[];
    localizationChanges: number;
  }>;
}

/** Load one reference: quests keyed by bare id, client version and sibling locale. */
export function loadSide(file: string): Side {
  const quests = new Map<string, Quest>();
  for (const quest of readQuestArray(file) as unknown as Quest[]) {
    // Key by the bare id: the enriched variant wraps it as `[<id>] Name`.
    if (typeof quest?._id === 'string') quests.set(canonicalQuestId(quest._id), quest);
  }
  return { file, appVersion: referenceAppVersion(file), quests, locale: loadSiblingLocale(file) };
}

function questName(side: Side, quest: Quest | undefined): string | undefined {
  if (!quest) return undefined;
  const raw = String(quest._id);
  const text = questText(quest, side.locale);
  return text(`${canonicalQuestId(raw)} name`) ?? text(`${raw} name`);
}

/** Every condition id inside `value` (conditions, counters, visibility rules). */
function conditionIds(value: unknown, keys: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) conditionIds(entry, keys);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if (typeof record.id === 'string') keys.add(canonicalQuestId(record.id));
  for (const entry of Object.values(record)) conditionIds(entry, keys);
}

/** Index `<id> <suffix>` locale keys by id so per-quest lookups stay cheap. */
function localeIndex(locale: Record<string, unknown>): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const key of Object.keys(locale)) {
    const id = /^([0-9a-f]{24}) /.exec(key)?.[1];
    if (id) index.set(id, [...(index.get(id) ?? []), key]);
  }
  return index;
}

/** Locale indexes, or null unless both references carry sibling client/locale text. */
function localeIndexes(
  older: Side,
  newer: Side
): [Map<string, string[]>, Map<string, string[]>] | null {
  const both = Object.keys(older.locale).length > 0 && Object.keys(newer.locale).length > 0;
  return both ? [localeIndex(older.locale), localeIndex(newer.locale)] : null;
}

/** Sibling locale strings of one quest (its `<id> ...` keys and condition ids). */
function localeChanges(
  id: string,
  pair: [Quest, Quest],
  sides: [Side, Side],
  indexes: [Map<string, string[]>, Map<string, string[]>]
): ValueChange[] {
  const keys = new Set([...(indexes[0].get(id) ?? []), ...(indexes[1].get(id) ?? [])]);
  conditionIds(pair[0].conditions, keys);
  conditionIds(pair[1].conditions, keys);
  const changes: ValueChange[] = [];
  for (const key of keys) {
    diffValues(sides[0].locale[key], sides[1].locale[key], `/locale/${key}`, changes);
  }
  return changes;
}

const isTextChange = (change: ValueChange): boolean =>
  change.path === '/localization' ||
  change.path.startsWith('/localization/') ||
  change.path.startsWith('/locale/');

/** Diff two references' quest definitions. */
export function diffReferences(older: Side, newer: Side, includeText: boolean): QuestDiff {
  const result: QuestDiff = {
    older: { file: older.file, appVersion: older.appVersion, quests: older.quests.size },
    newer: { file: newer.file, appVersion: newer.appVersion, quests: newer.quests.size },
    added: [...newer.quests]
      .filter(([id]) => !older.quests.has(id))
      .map(([id, quest]) => ({ id, name: questName(newer, quest) })),
    removed: [...older.quests]
      .filter(([id]) => !newer.quests.has(id))
      .map(([id, quest]) => ({ id, name: questName(older, quest) })),
    changed: [],
  };
  const indexes = localeIndexes(older, newer);
  for (const [id, quest] of older.quests) {
    const next = newer.quests.get(id);
    if (!next) continue;
    const changes = [
      ...diffValues(questDefinition(quest), questDefinition(next)),
      ...(indexes ? localeChanges(id, [quest, next], [older, newer], indexes) : []),
    ];
    const localizationChanges = changes.filter(isTextChange).length;
    const shown = includeText ? changes : changes.filter((change) => !isTextChange(change));
    if (shown.length === 0 && localizationChanges === 0) continue;
    result.changed.push({
      id,
      name: questName(newer, next) ?? questName(older, quest),
      changes: shown,
      localizationChanges,
    });
  }
  return result;
}

/** Content hash, so one capture copied to two paths counts as one reference. */
const fileDigest = (file: string): string =>
  createHash('sha256').update(readFileSync(file)).digest('hex');

/** Sort order that puts a capture's enriched ("rollinglatest.modified") variant first. */
const enrichedFirst = (a: string, b: string): number =>
  Number(/rollinglatest\.modified/i.test(b)) - Number(/rollinglatest\.modified/i.test(a));

/** File name without the enriched-variant suffix, shared by a raw/enriched pair. */
const captureBaseName = (file: string): string =>
  basename(file).replace(/\.rollinglatest\.modified(?=\.json$)/i, '');

/** The two most recent distinct references of `mode` under `directory` (older first). */
export function latestTwo(
  mode: GameMode,
  directory = resolveReferenceDirectory(referenceDirectory())
): [string, string] {
  // Same ranking and mode rule as findReferenceFile: capture timestamp, else
  // file mtime; a usable reference whose mode is undetectable stays a candidate.
  const ranked = findQuestListFiles(directory)
    .filter((file) => [mode, null].includes(modeFromReferenceFile(file) as GameMode | null))
    .map((file) => ({ file, capture: captureTimestamp(file) }))
    .map(({ file, capture }) => ({ file, capture, ts: capture ?? statSync(file).mtimeMs }))
    .sort((a, b) => b.ts - a.ts || enrichedFirst(a.file, b.file));
  // A capture's raw quest list and its enriched variant are one capture: they share
  // a directory and capture timestamp (or, without one, a base name) but differ in
  // bytes. Identical copies are also one reference. Keep the first (enriched on a
  // tie) file of each, and record the keys of every file seen, kept or skipped, so
  // a copy of a skipped raw file elsewhere cannot come back as a second reference.
  const seen = new Set<string>();
  const files: string[] = [];
  for (const { file, capture } of ranked) {
    const keys = [fileDigest(file), `${dirname(file)}|${capture ?? captureBaseName(file)}`];
    const duplicate = keys.some((key) => seen.has(key));
    keys.forEach((key) => seen.add(key));
    if (!duplicate) files.push(file);
  }
  if (files.length < 2) {
    throw new Error(
      `Need two ${mode} references under data/reference/ to compare, found ${files.length}`
    );
  }
  return [files[1], files[0]];
}

/** The pair to compare: two given files, or the two newest for the mode. */
export function selectFiles(positionals: string[], mode: GameMode): [string, string] {
  if (positionals.length === 2) return [positionals[0], positionals[1]];
  if (positionals.length !== 0) throw new Error('Pass either no files or exactly two');
  return latestTwo(mode);
}

const short = (value: unknown): string => {
  const text = value === undefined ? '(absent)' : JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
};

function sideLabel(side: QuestDiff['older']): string {
  const facts = `(${side.appVersion ?? 'unknown version'}, ${side.quests} quests)`;
  return `${relative(process.cwd(), side.file)} ${dim(facts)}`;
}

function printQuestList(title: string, rows: Array<{ id: string; name?: string }>, color: string) {
  if (rows.length === 0) return;
  console.log(bold(`\n${title} (${rows.length})`));
  for (const row of rows) {
    console.log(`  ${color}${row.name ?? '(unnamed)'}${colors.reset} ${dim(row.id)}`);
  }
}

function printChangedQuest(quest: QuestDiff['changed'][number]): void {
  const text =
    quest.localizationChanges > 0 ? `  localization: ${quest.localizationChanges} strings` : '';
  console.log(`  ${bold(quest.name ?? '(unnamed)')} ${dim(quest.id)}${dim(text)}`);
  for (const change of quest.changes) {
    console.log(
      `    ${change.path}\n` +
        `      ${colors.red}- ${short(change.before)}${colors.reset}\n` +
        `      ${colors.green}+ ${short(change.after)}${colors.reset}`
    );
  }
}

export function printDiff(diff: QuestDiff): void {
  printHeader('REFERENCE DIFF (quest definitions)');
  console.log(`  older: ${sideLabel(diff.older)}`);
  console.log(`  newer: ${sideLabel(diff.newer)}`);
  printQuestList('added', diff.added, colors.green);
  printQuestList('removed', diff.removed, colors.red);
  if (diff.added.length + diff.removed.length > 0) {
    console.log(
      dim(
        '  Quest lists are account-scoped: an added or removed quest may only reflect which quests each account could see.'
      )
    );
  }
  if (diff.changed.length > 0) console.log(bold(`\nchanged (${diff.changed.length})`));
  diff.changed.forEach(printChangedQuest);

  printHeader('SUMMARY');
  const total = diff.added.length + diff.removed.length + diff.changed.length;
  console.log(
    `  added: ${bold(String(diff.added.length))}  removed: ${bold(String(diff.removed.length))}  ` +
      `changed: ${bold(String(diff.changed.length))}`
  );
  if (total === 0) console.log(`  ${colors.green}Quest definitions are identical.${colors.reset}`);
  console.log();
}

function main(): void {
  try {
    const opts = parseModeArgs(process.argv.slice(2), ['--text']);
    const [olderFile, newerFile] = selectFiles(opts.positionals ?? [], opts.mode);
    const diff = diffReferences(loadSide(olderFile), loadSide(newerFile), opts.flags.has('--text'));
    printDiff(diff);
    if (opts.jsonOut) writeFileSync(opts.jsonOut, JSON.stringify(diff, null, 2));
    process.exitCode = 0;
  } catch (error) {
    printError('Error comparing references:', error as Error);
    process.exitCode = 1;
  }
}

if (isDirectExecution(import.meta.url)) {
  main();
}
