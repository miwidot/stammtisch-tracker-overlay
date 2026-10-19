/** Format and reference checks; missing upstream evidence is never treated as validation. */
import craftSchema from '../schemas/craft-additions.schema.json';
import itemSchema from '../schemas/item-additions.schema.json';
import taskSchema from '../schemas/task-additions.schema.json';
import sharedTaskSchema from '../schemas/task-shared.schema.json';
import traderRequirementSchema from '../schemas/trader-requirement.schema.json';
import perkSchema from '../schemas/seasonal-perk.schema.json';

type RecordData = Record<string, unknown>;
type Catalog = Map<string, RecordData>;
export type AdditionSection = 'itemsAdd' | 'craftsAdd' | 'tasksAdd' | 'seasonalPerks';

export interface AdditionContractContext {
  /** Upstream evidence only; additions must not become evidence of their own format. */
  items: Catalog;
  tasks: Catalog;
  /** Applicable overlay additions and aliases, used only for foreign-ID resolution. */
  itemsAdd?: Catalog;
  tasksAdd?: Catalog;
  stations: Catalog;
  crafts?: Catalog;
  traders?: Catalog;
  maps?: Catalog;
  categories?: Catalog;
  perks?: Catalog;
  /** Override patches validate supplied fields without requiring complete additions. */
  partial?: boolean;
}

export interface AdditionContractDiagnostic {
  id: string;
  field: string;
  status: 'invalid' | 'unverified';
  message: string;
}

interface Model {
  types: Set<string>;
  properties: Map<string, Model>;
  item?: Model;
  schema?: RecordData;
}

interface Check {
  id: string;
  section: AdditionSection;
  context: AdditionContractContext;
  diagnostics: AdditionContractDiagnostic[];
  /** Typed conditions are mandatory in supplied array entries, unlike optional patch fields. */
  complete?: boolean;
}

function record(value: unknown): value is RecordData {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function kind(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function emptyModel(): Model {
  return { types: new Set(), properties: new Map() };
}

function combine(left: Model, right: Model): Model {
  const merged = {
    types: new Set([...left.types, ...right.types]),
    properties: new Map(left.properties),
    item: left.item,
    schema: left.schema ?? right.schema,
  };
  right.properties.forEach((value, key) => {
    merged.properties.set(key, combine(left.properties.get(key) ?? emptyModel(), value));
  });
  if (right.item) merged.item = combine(left.item ?? emptyModel(), right.item);
  return merged;
}

function sampleModel(value: unknown): Model {
  const model = emptyModel();
  model.types.add(kind(value));
  if (Array.isArray(value)) model.item = sampleUnion(value);
  if (record(value)) {
    Object.entries(value).forEach(([key, entry]) => model.properties.set(key, sampleModel(entry)));
  }
  return model;
}

function sampleUnion(values: unknown[]): Model {
  return values.reduce<Model>((model, value) => combine(model, sampleModel(value)), emptyModel());
}

const schemas: Record<string, unknown> = {
  'craft-additions.schema.json': craftSchema,
  'task-additions.schema.json': taskSchema,
  'task-shared.schema.json': sharedTaskSchema,
  'trader-requirement.schema.json': traderRequirementSchema,
};

function resolveSchema(schema: RecordData, document: RecordData): [RecordData, RecordData] {
  if (typeof schema.$ref !== 'string') return [schema, document];
  const [filename, fragment = ''] = schema.$ref.split('#');
  const target = filename ? (schemas[filename] as RecordData) : document;
  const result = fragment
    .split('/')
    .slice(1)
    .reduce<unknown>((value, key) => {
      return record(value) ? value[key] : undefined;
    }, target);
  if (!record(result)) throw new Error(`Unresolved addition schema reference: ${schema.$ref}`);
  return [result, target];
}

function schemaTypes(schema: RecordData): string[] {
  if (Array.isArray(schema.type)) return schema.type as string[];
  if (typeof schema.type === 'string') return [schema.type];
  return [];
}

function schemaModel(raw: RecordData, document: RecordData): Model {
  const [schema, owner] = resolveSchema(raw, document);
  const model = emptyModel();
  model.schema = schema;
  schemaTypes(schema).forEach((type) => model.types.add(type));
  const properties = record(schema.properties) ? schema.properties : {};
  Object.entries(properties).forEach(([key, value]) => {
    if (record(value)) model.properties.set(key, schemaModel(value, owner));
  });
  if (record(schema.items)) model.item = schemaModel(schema.items, owner);
  return schemaAlternatives(model, schema, owner);
}

function schemaAlternatives(model: Model, schema: RecordData, owner: RecordData): Model {
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (!Array.isArray(alternatives)) return model;
  return alternatives.reduce<Model>((combined, value) => {
    return record(value) ? combine(combined, schemaModel(value, owner)) : combined;
  }, model);
}

const sectionSchemas: Record<AdditionSection, RecordData> = {
  itemsAdd: itemSchema,
  craftsAdd: craftSchema,
  tasksAdd: taskSchema,
  seasonalPerks: perkSchema,
};

function upstreamCatalog(section: AdditionSection, context: AdditionContractContext): Catalog {
  const catalogs = {
    itemsAdd: context.items,
    craftsAdd: context.crafts,
    tasksAdd: context.tasks,
    seasonalPerks: context.perks,
  };
  return catalogs[section] ?? new Map();
}

function additionModel(section: AdditionSection, context: AdditionContractContext): Model {
  const schema = sectionSchemas[section];
  const model = schemaModel(schema.additionalProperties as RecordData, schema);
  const samples = sampleUnion([...upstreamCatalog(section, context).values()]);
  const combined = combine(model, samples);
  if (section !== 'itemsAdd') retainDeclaredTypes(combined, model);
  supplementModel(section, combined);
  return combined;
}

/** Adapted task references and raw craft references must not widen into each other. */
function retainDeclaredTypes(model: Model, declared: Model): void {
  if (declared.types.size) model.types = new Set(declared.types);
  declared.properties.forEach((child, key) => retainChildTypes(model.properties.get(key), child));
  if (model.item && declared.item) retainDeclaredTypes(model.item, declared.item);
}

function retainChildTypes(model: Model | undefined, declared: Model): void {
  if (model) retainDeclaredTypes(model, declared);
}

function toolModel(model?: Model): void {
  if (!model) return;
  const attributes = model.properties.get('attributes');
  if (!attributes) return;
  attributes.properties.set('tool', schemaModel({ type: 'boolean' }, {}));
}

function supplementModel(section: AdditionSection, model: Model): void {
  if (section === 'craftsAdd') craftModels(model);
  if (section === 'tasksAdd') {
    model.properties.set('objectivesAdd', model.properties.get('objectives')!);
  }
  if (section === 'seasonalPerks') perkModels(model);
}

function craftModels(model: Model): void {
  toolModel(model.properties.get('requiredItems')?.item);
  toolModel(model.properties.get('productItem'));
}

function perkModels(model: Model): void {
  const ids = schemaModel({ type: 'array', items: { type: 'string' } }, {});
  model.properties.set('exclusiveToPerks', ids);
  model.properties.set('mutuallyExclusiveSeasonalPerkIds', ids);
}

function report(
  check: Check,
  field: string,
  status: 'invalid' | 'unverified',
  message: string
): void {
  check.diagnostics.push({ id: check.id, field: field || 'entity', status, message });
}

function unknownValue(check: Check, field: string, value: unknown, message: string): void {
  const entries = valueEntries(value);
  if (entries.length) {
    entries.forEach(([key, entry]) => unknownValue(check, `${field}.${key}`, entry, message));
    return;
  }
  report(check, field, 'unverified', message);
}

function valueEntries(value: unknown): [string, unknown][] {
  if (Array.isArray(value)) return value.map((entry, index) => [String(index), entry]);
  if (record(value)) return Object.entries(value);
  return [];
}

function typeMatches(model: Model, value: unknown): boolean {
  if (model.types.has(kind(value))) return true;
  return model.types.has('integer') && Number.isInteger(value);
}

function usefulModel(model: Model): boolean {
  if (model.schema) return true;
  return [...model.types].some((type) => type !== 'null');
}

function typeProblem(model: Model, value: unknown): string | undefined {
  if (!model.types.size) return undefined;
  if (typeMatches(model, value)) return undefined;
  return `Expected ${[...model.types].join(' or ')}, got ${kind(value)}`;
}

function numberProblem(schema: RecordData, value: number): string | undefined {
  if (!Number.isFinite(value)) return 'Expected a finite number';
  if (schema.type === 'integer' && !Number.isInteger(value)) return 'Expected an integer';
  return numberBoundsProblem(schema, value);
}

function numberBoundsProblem(schema: RecordData, value: number): string | undefined {
  if (typeof schema.minimum === 'number' && value < schema.minimum)
    return `Must be at least ${schema.minimum}`;
  return maximumProblem(schema, value);
}

function maximumProblem(schema: RecordData, value: number): string | undefined {
  if (typeof schema.maximum === 'number' && value > schema.maximum)
    return `Must be at most ${schema.maximum}`;
  return undefined;
}

function stringProblem(schema: RecordData, value: string): string | undefined {
  if (typeof schema.minLength === 'number' && value.length < schema.minLength)
    return `Must contain at least ${schema.minLength} characters`;
  return patternProblem(schema, value);
}

// Keep patterns literal; schema changes require explicit validator coverage.
const TRADER_REQUIREMENT_ID_PATTERN =
  /^(?:[0-9a-f]{24}(?:-[0-9a-f]{24})?|overlay\.(?:[0-9a-f]{24}|placeholder_[a-z0-9_]+)\.[0-9a-f]{24}\.(?:level\.>=\.[1-4]|reputation\.(?:>=|<=|>|<|=)\.-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)(?:\.occurrence\.(?:[2-9]|[1-9][0-9]+))?)$/;
const PUBLISHED_PATTERNS = new Map([
  [TRADER_REQUIREMENT_ID_PATTERN.source, TRADER_REQUIREMENT_ID_PATTERN],
]);

function patternProblem(schema: RecordData, value: string): string | undefined {
  if (typeof schema.pattern !== 'string') return undefined;
  const pattern = PUBLISHED_PATTERNS.get(schema.pattern);
  if (!pattern) throw new Error('Unsupported published addition pattern');
  return pattern.test(value) ? undefined : 'Does not match the published addition format';
}

function scalarProblem(schema: RecordData, value: unknown): string | undefined {
  if (typeof value === 'number') return numberProblem(schema, value);
  if (typeof value === 'string') return stringProblem(schema, value);
  return undefined;
}

function disallowedValue(schema: RecordData, value: unknown): boolean {
  if (!record(schema.not)) return false;
  if (!Object.keys(schema.not).length) return true;
  return Object.hasOwn(schema.not, 'const') && schema.not.const === value;
}

function constraintProblem(model: Model, value: unknown): string | undefined {
  const schema = constraintSchema(model, value);
  if (disallowedValue(schema, value)) return 'Value is excluded by the published addition format';
  return enumProblem(schema, value) ?? scalarProblem(schema, value);
}

function constraintSchema(model: Model, value: unknown): RecordData {
  const schema = model.schema ?? {};
  const alternatives = alternativeSchemas(schema);
  if (!Array.isArray(alternatives)) return schema;
  return alternatives.find((entry) => matchingAlternative(entry, value)) ?? schema;
}

function alternativeSchemas(schema: RecordData): unknown {
  return schema.anyOf ?? schema.oneOf;
}

function matchingAlternative(entry: unknown, value: unknown): boolean {
  if (!record(entry)) return false;
  return schemaTypes(entry).includes(kind(value));
}

function enumProblem(schema: RecordData, value: unknown): string | undefined {
  if (Array.isArray(schema.enum) && !schema.enum.includes(value))
    return `Expected one of ${schema.enum.join(', ')}`;
  return fixedValueProblem(schema, value);
}

function fixedValueProblem(schema: RecordData, value: unknown): string | undefined {
  if (Object.hasOwn(schema, 'const') && schema.const !== value) return 'Unexpected fixed value';
  return undefined;
}

const taskItemFields = new Set([
  'item',
  'items',
  'markerItem',
  'questItem',
  'containsAll',
  'useAny',
  'usingWeapon',
  'usingWeaponMods',
  'requiredKeys',
  'wearing',
  'notWearing',
  'keys',
]);

type CatalogName =
  'items' | 'tasks' | 'stations' | 'crafts' | 'traders' | 'maps' | 'categories' | 'perks';

function taskReference(field: string): CatalogName | undefined {
  const parts = field.split('.').filter((part) => !/^\d+$/.test(part));
  if (parts.at(-1) !== 'id') return undefined;
  const parent = parts.at(-2) ?? '';
  if (taskItemFields.has(parent)) return 'items';
  return (
    {
      trader: 'traders',
      traders: 'traders',
      traderUnlock: 'traders',
      map: 'maps',
      maps: 'maps',
      task: 'tasks',
      station: 'stations',
    } as const
  )[parent as 'trader'];
}

function craftReference(field: string): CatalogName | undefined {
  if (field === 'station') return 'stations';
  if (field === 'taskUnlock') return 'tasks';
  if (/^(requiredItems\.\d+|productItem)\.item$/.test(field)) return 'items';
  return undefined;
}

function perkReference(field: string): CatalogName | undefined {
  if (/^(exclusiveToPerks|mutuallyExclusiveSeasonalPerkIds)\.\d+$/.test(field)) return 'perks';
  if (field === 'id') return 'perks';
  return filterReference(field);
}

function filterReference(field: string): CatalogName | undefined {
  if (/itemFilter\.(allowedItems|excludedItems)\.\d+$/.test(field)) return 'items';
  if (/itemFilter\.(allowedCategories|excludedCategories)\.\d+$/.test(field)) return 'categories';
  return undefined;
}

const referenceResolvers = {
  itemsAdd: (_field: string): CatalogName | undefined => undefined,
  craftsAdd: craftReference,
  tasksAdd: taskReference,
  seasonalPerks: perkReference,
};

function missingReference(check: Check, field: string, catalog: string): void {
  if (seasonalFilter(check, field)) {
    report(
      check,
      field,
      'unverified',
      'Raw game filter ID is absent from the exposed catalog; upstream completeness is not established'
    );
    return;
  }
  const questItem = /questitem/i.test(field);
  report(
    check,
    field,
    questItem ? 'unverified' : 'invalid',
    questItem
      ? 'Quest-item templates are not proven complete by the item catalog'
      : `Reference not found in the available ${catalog} catalog or applicable additions`
  );
}

function seasonalFilter(check: Check, field: string): boolean {
  return check.section === 'seasonalPerks' && field.includes('.itemFilter.');
}

function validateReference(check: Check, field: string, value: unknown): boolean {
  const name = referenceResolvers[check.section](field);
  if (!name) return false;
  if (unknownTaskUnlock(check, field, value)) return true;
  checkReference(check, field, value, name);
  return true;
}

function unknownTaskUnlock(check: Check, field: string, value: unknown): boolean {
  return check.section === 'craftsAdd' && field === 'taskUnlock' && value === null;
}

function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && !!value.trim();
}

function checkReference(check: Check, field: string, value: unknown, name: CatalogName): void {
  if (!nonemptyString(value)) {
    report(check, field, 'invalid', 'Expected a nonempty reference ID');
    return;
  }
  if (malformedFilterId(check, field, value, name)) {
    report(check, field, 'invalid', 'Expected a raw game item/category template ID');
    return;
  }
  resolveReference(check, field, value, name);
}

function malformedFilterId(check: Check, field: string, value: string, name: CatalogName): boolean {
  if (!seasonalFilter(check, field)) return false;
  if (referenceCatalog(check, name).has(value)) return false;
  return !/^[0-9a-f]{24}$/.test(value);
}

function resolveReference(check: Check, field: string, value: string, name: CatalogName): void {
  const catalog = referenceCatalog(check, name);
  if (!catalog.size) report(check, field, 'unverified', `No ${name} catalog available`);
  else if (!catalog.has(value)) missingReference(check, field, name);
}

function referenceCatalog(check: Check, name: CatalogName): Catalog {
  const catalog = check.context[name] ?? new Map();
  const additions = { items: check.context.itemsAdd, tasks: check.context.tasksAdd }[
    name as 'items'
  ];
  return new Map([...catalog, ...(additions ?? [])]);
}

function rawEffectEvidence(check: Check, field: string, value: unknown): void {
  if (!unexposedRawEffect(check, field)) return;
  if (record(value) || Array.isArray(value)) return;
  report(
    check,
    field,
    'unverified',
    'Raw effect value is not exposed upstream; format only was checked'
  );
}

function extensionEvidence(check: Check, field: string): void {
  if (field.startsWith('gameEditions.')) {
    report(
      check,
      field,
      'unverified',
      'Edition identifier has no authoritative catalog in this context'
    );
    return;
  }
  legacyExclusionEvidence(check, field);
}

function legacyExclusionEvidence(check: Check, field: string): void {
  if (!field.startsWith('mutuallyExclusiveSeasonalPerkIds.')) return;
  report(
    check,
    field,
    'unverified',
    'Legacy overlay field is not the exposed raw upstream exclusion field'
  );
}

function unexposedRawEffect(check: Check, field: string): boolean {
  if (check.section !== 'seasonalPerks') return false;
  if (!field.startsWith('effects.')) return false;
  const perk = check.context.perks?.get(check.id);
  return !exposesEffects(perk);
}

function exposesEffects(perk?: RecordData): boolean {
  return Array.isArray(perk?.effects) && perk.effects.length > 0;
}

function requiredFields(check: Check, field: string, value: RecordData, model: Model): void {
  requiredKeys(check, constraintSchema(model, value), value).forEach((key) => {
    if (!Object.hasOwn(value, key))
      report(
        check,
        field ? `${field}.${key}` : key,
        'invalid',
        'Required addition field is missing'
      );
  });
}

function requiredKeys(check: Check, schema: RecordData, value: RecordData): string[] {
  if (!check.context.partial) return schemaRequiredKeys(schema, value);
  if (!check.complete) return [];
  return [...conjunctionRequiredKeys(schema, value), ...conditionalRequiredKeys(schema, value)];
}

function schemaRequiredKeys(schema: RecordData, value: RecordData): string[] {
  const own = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  return [
    ...own,
    ...conjunctionRequiredKeys(schema, value),
    ...conditionalRequiredKeys(schema, value),
  ];
}

function conjunctionRequiredKeys(schema: RecordData, value: RecordData): string[] {
  if (!Array.isArray(schema.allOf)) return [];
  return schema.allOf.filter(record).flatMap((entry) => schemaRequiredKeys(entry, value));
}

function conditionalRequiredKeys(schema: RecordData, value: RecordData): string[] {
  if (!record(schema.if)) return [];
  const branch = conditionMatches(schema.if, value) ? schema.then : schema.else;
  return record(branch) ? schemaRequiredKeys(branch, value) : [];
}

function conditionMatches(schema: RecordData, value: unknown): boolean {
  const model = { ...emptyModel(), types: new Set(schemaTypes(schema)), schema };
  if (typeProblem(model, value) || constraintProblem(model, value)) return false;
  return record(value) ? conditionObjectMatches(schema, value) : true;
}

function conditionObjectMatches(schema: RecordData, value: RecordData): boolean {
  return conditionRequiredMatches(schema, value) && conditionPropertiesMatch(schema, value);
}

function conditionRequiredMatches(schema: RecordData, value: RecordData): boolean {
  if (!Array.isArray(schema.required)) return true;
  return schema.required.every((key) => Object.hasOwn(value, key));
}

function conditionPropertiesMatch(schema: RecordData, value: RecordData): boolean {
  if (!record(schema.properties)) return true;
  return Object.entries(schema.properties).every(([key, child]) =>
    conditionPropertyMatches(child, value, key)
  );
}

function conditionPropertyMatches(schema: unknown, value: RecordData, key: string): boolean {
  if (!Object.hasOwn(value, key)) return true;
  return record(schema) ? conditionMatches(schema, value[key]) : true;
}

function walkObject(check: Check, field: string, value: RecordData, model: Model): void {
  requiredFields(check, field, value, model);
  Object.entries(value).forEach(([key, entry]) => {
    const child = field ? `${field}.${key}` : key;
    walk(check, child, entry, model.properties.get(key));
  });
}

function walkArray(check: Check, field: string, value: unknown[], model: Model): void {
  const minimum = model.schema?.minItems;
  if (typeof minimum === 'number' && value.length < minimum)
    report(check, field, 'invalid', `Expected at least ${minimum} entries`);
  value.forEach((entry, index) =>
    walk({ ...check, complete: true }, `${field}.${index}`, entry, model.item)
  );
}

function walkChildren(check: Check, field: string, value: unknown, model: Model): void {
  if (record(value)) walkObject(check, field, value, model);
  if (Array.isArray(value)) walkArray(check, field, value, model);
  traderRequirement(check, field, value);
}

function traderRequirement(check: Check, field: string, value: unknown): void {
  if (!/^traderRequirements\.\d+$/.test(field)) return;
  if (!record(value)) return;
  if (value.requirementType !== 'level') return;
  traderLevelThreshold(check, field, value);
}

function validLoyaltyLevel(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 4;
}

function traderLevelThreshold(check: Check, field: string, value: RecordData): void {
  traderLevelValue(check, field, value);
  traderLevelComparison(check, field, value);
}

function suppliedOrRequired(check: Check, value: RecordData, key: string): boolean {
  return !check.context.partial || Object.hasOwn(value, key);
}

function traderLevelValue(check: Check, field: string, value: RecordData): void {
  if (suppliedOrRequired(check, value, 'value') && !validLoyaltyLevel(value.value))
    report(
      check,
      `${field}.value`,
      'invalid',
      'Trader loyalty level must be an integer from 1 to 4'
    );
}

function traderLevelComparison(check: Check, field: string, value: RecordData): void {
  if (suppliedOrRequired(check, value, 'compareMethod') && value.compareMethod !== '>=')
    report(
      check,
      `${field}.compareMethod`,
      'invalid',
      'Trader loyalty level comparison must be >='
    );
}

function objectivePatch(check: Check, field: string, value: unknown, model: Model): boolean {
  if (!check.context.partial || field !== 'objectives' || !record(value)) return false;
  Object.entries(value).forEach(([id, objective]) =>
    walk(check, `${field}.${id}`, objective, model.item)
  );
  return true;
}

function walk(check: Check, field: string, value: unknown, model?: Model): void {
  if (!knownModel(model)) {
    unknownValue(
      check,
      field,
      value,
      'Field has no modeled upstream structure or sufficient type evidence'
    );
    return;
  }
  if (objectivePatch(check, field, value, model)) return;
  walkKnown(check, field, value, model);
}

function knownModel(model?: Model): model is Model {
  return !!model && usefulModel(model);
}

function walkKnown(check: Check, field: string, value: unknown, model: Model): void {
  const problem = typeProblem(model, value) ?? constraintProblem(model, value);
  if (problem) {
    report(check, field, 'invalid', problem);
    return;
  }
  const reference = validateReference(check, field, value);
  if (!reference) rawEffectEvidence(check, field, value);
  extensionEvidence(check, field);
  opaqueValueEvidence(check, field, value, model);
  walkChildren(check, field, value, model);
}

function opaqueValueEvidence(check: Check, field: string, value: unknown, model: Model): void {
  if (!record(value)) return;
  if (model.properties.size || Object.keys(value).length) return;
  report(check, field, 'unverified', 'Object has no modeled upstream fields');
}

function stationLevel(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (!record(value)) return undefined;
  return typeof value.level === 'number' ? value.level : undefined;
}

function validateStationLevel(check: Check, addition: RecordData): void {
  const station = check.context.stations.get(String(addition.station));
  if (!station || !Number.isInteger(addition.level)) return;
  compareStationLevel(check, addition.level as number, station);
}

function compareStationLevel(check: Check, level: number, station: RecordData): void {
  const known = knownStationLevels(station);
  if (!known.length)
    report(check, 'level', 'unverified', 'Station level availability is not exposed');
  else if (!known.includes(level))
    report(
      check,
      'level',
      'invalid',
      'Required level is absent from the referenced hideout station'
    );
}

function knownStationLevels(station: RecordData): number[] {
  const levels = Array.isArray(station.levels) ? station.levels.map(stationLevel) : [];
  return levels.filter((level) => level !== undefined);
}

function validateCraft(check: Check, addition: RecordData): void {
  validateStationLevel(check, addition);
  if (addition.taskUnlock === null)
    report(check, 'taskUnlock', 'unverified', 'Quest-gated craft has an unknown unlocking task');
}

function additionIdentity(check: Check, addition: RecordData): void {
  if (typeof addition.id !== 'string') return;
  if (addition.id !== check.id)
    report(check, 'id', 'invalid', 'Addition ID must match its object key');
  if (!addition.id.trim()) report(check, 'id', 'invalid', 'Expected a nonempty addition ID');
}

function ownCatalog(
  section: AdditionSection,
  additions: RecordData,
  context: AdditionContractContext
): AdditionContractContext {
  const name = ({ itemsAdd: 'items', tasksAdd: 'tasks' } as const)[section as 'itemsAdd'];
  if (!name) return context;
  const catalog = new Map({ items: context.itemsAdd, tasks: context.tasksAdd }[name]);
  Object.entries(additions).forEach(([id, value]) => {
    if (record(value)) catalog.set(id, { ...catalog.get(id), ...value });
  });
  return { ...context, [`${name}Add`]: catalog };
}

function validateAddition(check: Check, value: unknown, model: Model): void {
  if (!record(value)) {
    report(check, 'entity', 'invalid', 'Expected an addition object');
    return;
  }
  additionIdentity(check, value);
  walk(check, '', value, model);
  if (check.section === 'craftsAdd') validateCraft(check, value);
}

/** Synthetic identities are allowed; foreign IDs must resolve in the supplied catalogs. */
export function validateAdditionContracts(
  section: AdditionSection,
  additions: RecordData,
  context: AdditionContractContext
): AdditionContractDiagnostic[] {
  const diagnostics: AdditionContractDiagnostic[] = [];
  const effectiveContext = ownCatalog(section, additions, context);
  const model = additionModel(section, context);
  Object.entries(additions).forEach(([id, value]) => {
    validateAddition({ id, section, context: effectiveContext, diagnostics }, value, model);
  });
  return diagnostics;
}
