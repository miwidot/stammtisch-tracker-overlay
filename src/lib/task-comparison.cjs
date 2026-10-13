'use strict';

const snapshots = new WeakMap();
const contexts = new WeakMap();
const REFERENCE_KINDS = {
  taskRequirements: 'requirement',
  traderRequirements: 'requirement',
  taskRequirementGroups: 'requirementGroups',
  objectives: 'objective',
  task: 'task',
  requiredPrestige: 'prestige',
  trader: 'trader',
  traders: 'trader',
  traderUnlock: 'trader',
  traderDialogueUnlock: 'trader',
  map: 'map',
  maps: 'map',
  locationUnlock: 'map',
  item: 'item',
  items: 'item',
  markerItem: 'item',
  questItem: 'item',
  useAny: 'item',
  containsAll: 'item',
  usingWeapon: 'item',
  usingWeaponMods: 'item',
  requiredKeys: 'item',
  wearing: 'item',
  notWearing: 'item',
  keys: 'item',
};

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function source(records, translations, fields = ['name']) {
  return { records, translations, fields };
}

function createTextSources(context) {
  return {
    task: source(context.tasksById, context.tasksEn),
    objective: source(new Map(), context.tasksEn, ['description']),
    item: source(
      new Map([...context.questItemsById, ...context.itemsById]),
      { ...context.tasksEn, ...context.itemsEn },
      ['name', 'shortName']
    ),
    map: source(context.mapsById, context.mapsEn),
    trader: source(context.tradersById, context.tradersEn),
    prestige: source(context.prestigeById, context.tasksEn),
  };
}

function textSources(context) {
  if (!contexts.has(context)) contexts.set(context, createTextSources(context));
  return contexts.get(context);
}

function comparisonTranslation(key, translations) {
  if (typeof key !== 'string' || !Object.hasOwn(translations, key)) return undefined;
  const value = translations[key];
  return usableTranslation(value, key);
}

function usableTranslation(value, key) {
  if (typeof value !== 'string') return undefined;
  if (!value.trim() || value === key) return undefined;
  return value;
}

function rawRecord(value, raw, records) {
  const known = records.get(value.id);
  if (known) return known;
  const inline = record(raw);
  return inline?.id === value.id ? inline : undefined;
}

function resolveTexts(value, raw, kind, sources) {
  const textSource = sources[kind];
  if (!textSource) return;
  const original = rawRecord(value, raw, textSource.records);
  for (const field of textSource.fields) {
    value[field] = comparisonTranslation(original?.[field], textSource.translations);
  }
}

function rawChild(raw, key) {
  const original = record(raw);
  return original && Object.hasOwn(original, key) ? original[key] : undefined;
}

function rawEntry(raw, index) {
  return Array.isArray(raw) ? raw[index] : undefined;
}

function referenceId(value) {
  const id = typeof value === 'string' ? value : record(value)?.id;
  return typeof id === 'string' && id.length > 0;
}

/** Reference matrices and unlock rewards deliberately accept singleton references. */
function rawArray(raw, kind, sources) {
  if (Array.isArray(raw)) return raw;
  return sources[kind] && referenceId(raw) ? [raw] : undefined;
}

/** A filtered collection cannot prove either membership or an explicit empty value. */
function arrayMemberKind(kind) {
  return kind === 'requirementGroups' ? 'requirement' : kind;
}

function cloneArray(value, raw, kind, sources) {
  const original = rawArray(raw, kind, sources);
  if (!original || original.length !== value.length) return undefined;
  const entries = value.map((entry, index) =>
    clone(entry, rawEntry(original, index), arrayMemberKind(kind), sources)
  );
  return comparableEntries(entries, kind) ? entries : undefined;
}

function nonemptyGroup(value) {
  return Array.isArray(value) && value.length > 0;
}

function comparableEntries(entries, kind) {
  if (kind === 'requirement') return entries.every((entry) => Boolean(record(entry)));
  if (kind === 'requirementGroups') return entries.every(nonemptyGroup);
  return entries.every((entry) => entry !== undefined);
}

function comparableRecord(value, raw, kind, sources) {
  if (!sources[kind]) return Boolean(record(raw));
  if (Object.hasOwn(value, 'id')) return referenceId(raw);
  return Boolean(record(raw));
}

function cloneRecord(value, raw, kind, sources) {
  const result = Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      clone(entry, rawChild(raw, key), REFERENCE_KINDS[key] ?? 'data', sources),
    ])
  );
  resolveTexts(result, raw, kind, sources);
  return result;
}

function clone(value, raw, kind, sources) {
  if (Array.isArray(value)) return cloneArray(value, raw, kind, sources);
  const normalized = record(value);
  if (!normalized) return value;
  return comparableRecord(normalized, raw, kind, sources)
    ? cloneRecord(normalized, raw, kind, sources)
    : undefined;
}

/** Register evidence alongside an adapted task without adding serialized fields. */
function registerTaskComparison(task, raw, context) {
  snapshots.set(task, clone(task, raw, 'task', textSources(context)));
}

/** Display fallbacks remain on the task; absent dictionary text is unavailable here. */
function comparisonTask(task) {
  return snapshots.get(task) ?? task;
}

module.exports = { registerTaskComparison, comparisonTask, comparisonTranslation };
