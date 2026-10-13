const { registerTaskComparison, comparisonTranslation } = require('../../src/lib/task-comparison.cjs');
const {
  validObjectiveCollection,
  buildItemComparisonIndex,
  comparisonRecords,
  translateComparisonValues,
  validateTranslationMap,
  MAX_RESPONSE_BYTES: TARKOV_JSON_MAX_BYTES,
  createTaskNormalizers,
  buildTaskContext: buildSharedTaskContext,
  fetchCached,
  mapOptionalArray,
  readResponseJson,
  resolveDialogueTraderRefs: resolveSharedDialogueTraderRefs,
} = require('../../src/lib/tarkov-api-shared.cjs');
const { fetchTarkovJson, SAFE_LANGUAGES } = require('./tarkov-transport.js');
function getValueType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_RETRIES = 3;
const MAX_BACKOFF_MS = 5000;
const TARKOV_JSON_TIMEOUT_MS = 30000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringId(value) {
  if (typeof value === 'string') return value;
  if (isRecord(value) && typeof value.id === 'string') return value.id;
  return undefined;
}

function compact(value) {
  // Null-prototype result so untrusted keys (e.g. `__proto__` from remote JSON)
  // cannot pollute Object.prototype.
  const result = Object.create(null);
  for (const [key, entry] of Object.entries(value)) {
    if (UNSAFE_KEYS.has(key)) continue;
    if (entry !== undefined) result[key] = entry;
  }
  return result;
}

function toLookup(value) {
  const map = new Map();
  const records = Array.isArray(value) ? value : isRecord(value) ? Object.values(value) : [];
  for (const entry of records) {
    if (isRecord(entry) && typeof entry.id === 'string') map.set(entry.id, entry);
  }
  return map;
}

function translate(map, key) {
  if (typeof key !== 'string' || UNSAFE_KEYS.has(key)) return undefined;
  const value = map[key];
  return typeof value === 'string' ? value : key;
}

function validateEnvelope(payload, path) {
  if (!isRecord(payload) || !('data' in payload) || payload.data == null) {
    const error = new Error(`Invalid json.tarkov.dev response for ${path}: missing data`);
    error.fatal = true;
    throw error;
  }
  if (payload.translations !== undefined && !Array.isArray(payload.translations)) {
    const error = new Error(
      `Invalid json.tarkov.dev response for ${path}: translations is not an array`
    );
    error.fatal = true;
    throw error;
  }
  return payload;
}

function isFatalFetchError(error, retryNotFound) {
  return error && (error.fatal || (!retryNotFound && /request failed: 404\b/.test(error.message)));
}

async function fetchEnvelopeAttempt(path, controller) {
  const response = await fetchTarkovJson(path, controller.signal);
  if (!response.ok)
    throw new Error(
      `tarkov.dev request failed: ${response.status} ${response.statusText} (${path})`
    );
  return validateEnvelope(await readResponseJson(response, path, TARKOV_JSON_MAX_BYTES), path);
}

async function fetchEnvelopeOnce(path, retryNotFound = true) {
  if (typeof fetch !== 'function') {
    throw new Error('Global fetch is not available. Node 22.0.0+ is required');
  }
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TARKOV_JSON_TIMEOUT_MS);
    try {
      return await fetchEnvelopeAttempt(path, controller);
    } catch (error) {
      if (isFatalFetchError(error, retryNotFound)) throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt === MAX_RETRIES) break;
      await sleep(Math.min(1000 * 2 ** (attempt - 1), MAX_BACKOFF_MS));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error(`Failed to fetch ${path}`);
}

// A caller-supplied cache shares concurrent reads across one refresh.
// Standalone callers receive their own cache; new refreshes fetch fresh data.
function fetchEnvelope(cache, path, retryNotFound = true) {
  return fetchCached(cache, path, (requestedPath) =>
    fetchEnvelopeOnce(requestedPath, retryNotFound)
  );
}

async function fetchTranslations(cache, mode, endpoint) {
  const optional = mode === 'pvp-season' && endpoint === 'items';
  try {
    const envelope = await fetchEnvelope(cache, `${mode}/${endpoint}_en`, !optional);
    if (!isRecord(envelope.data)) {
      const error = new Error(
        `Invalid json.tarkov.dev response for ${mode}/${endpoint}_en: expected data object`
      );
      error.fatal = true;
      throw error;
    }
    return validateTranslationMap(envelope.data, `${mode}/${endpoint}_en`);
  } catch (error) {
    if (optional && error instanceof Error && /request failed: 404\b/.test(error.message)) {
      return {};
    }
    throw error;
  }
}

const {
  resolveItemRef,
  resolveItemRefs,
  resolveMapRef,
  resolveTraderRef,
  resolveTaskRef,
  resolveRequiredPrestige,
  adaptObjective,
  adaptReward,
} = createTaskNormalizers({ isRecord, compact, stringId, translate });

function adaptTaskTrader(value, ctx) {
  if (value === undefined) return undefined;
  return resolveTraderRef(value, ctx) || { id: '', name: 'Unknown trader' };
}

function adaptTaskRequirement(raw, ctx) {
  if (!isRecord(raw)) return raw;
  return compact({ ...raw, task: resolveTaskRef(raw.task, ctx) });
}

function adaptTaskRequirementGroup(value, ctx) {
  return Array.isArray(value) ? value.map((req) => adaptTaskRequirement(req, ctx)) : [];
}

function adaptTraderRequirement(raw, ctx) {
  if (!isRecord(raw)) return raw;
  return compact({ ...raw, trader: resolveTraderRef(raw.trader, ctx) });
}

function adaptOtherRequirement(raw, ctx) {
  if (!isRecord(raw)) return { id: 'malformed-requirement', type: 'malformed' };
  return compact({
    ...raw,
    id: typeof raw.id === 'string' ? raw.id : 'malformed-requirement',
    type: typeof raw.type === 'string' ? raw.type : 'malformed',
    traders: resolveSharedDialogueTraderRefs(raw.traders, ctx, resolveTraderRef),
  });
}

function adaptKeyRequirement(raw, ctx) {
  if (!isRecord(raw)) return raw;
  return compact({
    ...raw,
    map: resolveMapRef(raw.map, ctx),
    keys: resolveItemRefs(raw.keys, ctx),
  });
}

function adaptTaskMap(value, ctx) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return resolveMapRef(value, ctx) || { id: '', name: 'Unknown map' };
}

function adaptTask(raw, ctx) {
  const id = stringId(raw) || '';
  const task = compact({
    ...raw,
    id,
    name: translate(ctx.tasksEn, raw.name) || id,
    trader: adaptTaskTrader(raw.trader, ctx),
    minPlayerLevel: raw.minPlayerLevel,
    disabled: raw.disabled,
    wikiLink: typeof raw.wikiLink === 'string' ? raw.wikiLink : undefined,
    map: adaptTaskMap(raw.map, ctx),
    kappaRequired: typeof raw.kappaRequired === 'boolean' ? raw.kappaRequired : undefined,
    lightkeeperRequired: raw.lightkeeperRequired,
    factionName: raw.factionName,
    requiredPrestige: resolveRequiredPrestige(raw.requiredPrestige, ctx),
    taskRequirements: mapOptionalArray(raw.taskRequirements, (req) =>
      adaptTaskRequirement(req, ctx)
    ),
    taskRequirementGroups: mapOptionalArray(raw.taskRequirementGroups, (group) =>
      adaptTaskRequirementGroup(group, ctx)
    ),
    traderRequirements: mapOptionalArray(raw.traderRequirements, (req) =>
      adaptTraderRequirement(req, ctx)
    ),
    otherRequirements: mapOptionalArray(raw.otherRequirements, (requirement) =>
      adaptOtherRequirement(requirement, ctx)
    ),
    neededKeys: mapOptionalArray(raw.neededKeys, (requirement) =>
      adaptKeyRequirement(requirement, ctx)
    ),
    availableDelaySecondsMin: raw.availableDelaySecondsMin,
    availableDelaySecondsMax: raw.availableDelaySecondsMax,
    experience: typeof raw.experience === 'number' ? raw.experience : undefined,
    objectives: validObjectiveCollection(raw.objectives)
      ? raw.objectives.map((objective) => adaptObjective(objective, ctx))
      : undefined,
    startRewards: adaptReward(raw.startRewards, ctx),
    finishRewards: adaptReward(raw.finishRewards, ctx),
  });
  registerTaskComparison(task, raw, ctx);
  return task;
}

async function buildTaskContext(cache, mode, tasksData) {
  return buildSharedTaskContext(cache, mode, tasksData, {
    fetchEnvelope,
    fetchTranslations,
    isRecord,
    toLookup,
  });
}

async function fetchApiTasks(mode, cache = new Map()) {
  const gameMode = mode || 'regular';
  if (typeof gameMode !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(gameMode)) {
    throw new Error('Invalid game mode');
  }
  // The monitor supplies one cache per mode refresh; standalone reads stay fresh.
  const tasksEnvelope = await fetchEnvelope(cache, `${gameMode}/tasks`);
  const tasksData = isRecord(tasksEnvelope.data) ? tasksEnvelope.data : undefined;
  if (!tasksData || !isRecord(tasksData.tasks)) {
    throw new Error(
      `Invalid json.tarkov.dev response for ${gameMode}/tasks: expected data.tasks object, got ${getValueType(
        tasksData && tasksData.tasks
      )}`
    );
  }
  if (Object.keys(tasksData.tasks).length === 0)
    throw new Error(`Invalid ${gameMode}/tasks: empty task collection`);
  const tasks = [];
  const seenIds = new Set();
  for (const [sourceKey, rawTask] of Object.entries(tasksData.tasks)) {
    if (!isRecord(rawTask)) {
      const error = new Error(
        `Invalid json.tarkov.dev response for ${gameMode}/tasks: task '${sourceKey}' is not an object`
      );
      error.fatal = true;
      throw error;
    }
    const id = stringId(rawTask);
    if (!id) {
      const error = new Error(
        `Invalid json.tarkov.dev response for ${gameMode}/tasks: task '${sourceKey}' has no id`
      );
      error.fatal = true;
      throw error;
    }
    if (seenIds.has(id)) {
      const error = new Error(
        `Invalid json.tarkov.dev response for ${gameMode}/tasks: duplicate task id '${id}'`
      );
      error.fatal = true;
      throw error;
    }
    seenIds.add(id);
    tasks.push(rawTask);
  }
  const ctx = await buildTaskContext(cache, gameMode, tasksData);
  return tasks.map((rawTask) => adaptTask(rawTask, ctx));
}

function entityCollection(data, key) {
  if (!key || Array.isArray(data)) return data;
  return data[key];
}

function seasonCollection(data) {
  if (!isRecord(data.perks)) throw new Error('Invalid seasonal perk catalog');
  const groups = Object.values(data.perks);
  if (!groups.every(Array.isArray)) throw new Error('Invalid seasonal perk groups');
  return groups.flat();
}

function seasonalComparisonRecord(record, translations) {
  const translated = translateComparisonValues(record, translations);
  for (const field of ['name', 'description']) {
    delete translated[field];
    const text = comparisonTranslation(record[field], translations);
    if (text !== undefined) translated[field] = text;
  }
  return translated;
}

function requireEntityMode(mode, endpoint) {
  if (endpoint === 'season' && mode !== 'pvp-season') {
    throw new Error('Seasonal perks are only exposed in pvp-season');
  }
}

function entityComparisonRecords(data, mode, endpoint) {
  const key = { items: 'items', maps: 'maps', crafts: 'crafts' }[endpoint];
  const collection = endpoint === 'season' ? seasonCollection(data) : entityCollection(data, key);
  return comparisonRecords(collection, `${mode}/${endpoint}`);
}

async function completeItemComparison(data, translations, mode, cache) {
  const [tasks, tasksEn] = await Promise.all([
    fetchEnvelope(cache, `${mode}/tasks`),
    fetchEnvelope(cache, `${mode}/tasks_en`, false),
  ]);
  comparisonRecords(tasks.data?.tasks, `${mode}/tasks`);
  return buildItemComparisonIndex(data, tasks.data, translations, tasksEn.data);
}

function translatedEntityComparison(record, translations, endpoint) {
  if (endpoint === 'season') return seasonalComparisonRecord(record, translations);
  return translateComparisonValues(record, translations);
}

async function fetchApiEntities(mode, endpoint, cache = new Map()) {
  requireEntityMode(mode, endpoint);
  const envelope = await fetchEnvelope(cache, `${mode}/${endpoint}`);
  const records = entityComparisonRecords(envelope.data, mode, endpoint);
  if (endpoint === 'crafts') return new Map(records.map(record => [record.id, record]));
  const translated = await fetchEnvelope(cache, `${mode}/${endpoint}_en`, false);
  const translations = validateTranslationMap(translated.data, `${mode}/${endpoint}_en`);
  if (endpoint === 'items') return completeItemComparison(envelope.data, translations, mode, cache);
  return new Map(records.map(record => [record.id, translatedEntityComparison(record, translations, endpoint)]));
}

function localeText(value, translations) {
  return comparisonTranslation(value, translations);
}

function localeObjective(record, translations) {
  return compact({ id: record.id, description: localeText(record.description, translations) });
}

function hasLocaleSourceText(value) {
  return typeof value === 'string' && Boolean(value.trim());
}

function localeField(record, field, translations) {
  const suffix = { name: 'Name', shortName: 'ShortName', description: 'Description' }[field];
  const key = hasLocaleSourceText(record[field]) ? record[field] : `${record.id} ${suffix}`;
  return localeText(key, translations);
}

function localeRecord(record, translations) {
  const translated = { ...record };
  for (const field of ['name', 'shortName', 'description']) {
    delete translated[field];
    const value = localeField(record, field, translations);
    if (value !== undefined) translated[field] = value;
  }
  delete translated.objectives;
  if (validObjectiveCollection(record.objectives)) {
    translated.objectives = record.objectives.map(objective => localeObjective(objective, translations));
  }
  return translated;
}

function localeIndex(collection, translations, label, allowEmpty = false) {
  return new Map(comparisonRecords(collection, label, allowEmpty).map(record =>
    [record.id, localeRecord(record, translations)]));
}

function optionalLocaleIndex(collection, translations, label) {
  if (collection === undefined) return undefined;
  return localeIndex(collection, translations, label, true);
}

function localeCollection(data, endpoint) {
  if (endpoint === 'traders') return data;
  if (!isRecord(data)) throw new Error(`Invalid ${endpoint} locale source`);
  return data[endpoint];
}

async function localeEndpoint(cache, mode, endpoint, locale) {
  const [source, translated] = await Promise.all([
    fetchEnvelope(cache, `${mode}/${endpoint}`),
    fetchEnvelope(cache, `${mode}/${endpoint}_${locale}`, false),
  ]);
  const translations = validateTranslationMap(translated.data, `${mode}/${endpoint}_${locale}`);
  const collection = localeCollection(source.data, endpoint);
  const result = { [endpoint]: localeIndex(collection, translations, `${mode}/${endpoint}`) };
  if (['tasks', 'items'].includes(endpoint)) result.dictionaryItems = localeDictionaryItems(translations);
  if (endpoint !== 'tasks') return result;
  result.questItems = optionalLocaleIndex(source.data.questItems, translations, `${mode}/questItems`);
  result.prestige = optionalLocaleIndex(source.data.prestige, translations, `${mode}/prestige`);
  return result;
}

function dictionaryLocaleItem(key, translations) {
  const match = /^([a-f0-9]{24}) Name$/.exec(key);
  if (!match) return undefined;
  const name = translations[key];
  if (!name.trim() || name === key) return undefined;
  return compact({ id: match[1], name,
    shortName: localeText(`${match[1]} ShortName`, translations),
    description: localeText(`${match[1]} Description`, translations) });
}

function localeDictionaryItems(translations) {
  const items = new Map();
  for (const key of Object.keys(translations)) {
    const item = dictionaryLocaleItem(key, translations);
    if (item) items.set(item.id, item);
  }
  return items;
}

function localeDictionarySnapshot(snapshots, tasks) {
  const items = new Map();
  const dictionaries = snapshots.map(snapshot => snapshot.dictionaryItems || new Map());
  for (const dictionary of dictionaries) {
    for (const [id, item] of dictionary) {
      if (!tasks.has(id)) items.set(id, item);
    }
  }
  return items;
}

function completeLocaleItems(snapshots, result) {
  const dictionary = localeDictionarySnapshot(snapshots, result.tasks);
  result.items = new Map([...dictionary, ...(result.questItems || []), ...result.items]);
  delete result.dictionaryItems;
  return result;
}

async function fetchApiLocales(mode, locale, cache = new Map()) {
  if (!SAFE_LANGUAGES.has(locale)) throw new Error('Unsupported upstream language');
  const catalog = await fetchEnvelope(cache, 'endpoints');
  const languages = catalog.data.languages;
  if (!Array.isArray(languages) || !languages.includes(locale)) throw new Error('Unsupported upstream language');
  const snapshots = await Promise.all(['tasks', 'items', 'maps', 'traders'].map(endpoint =>
    localeEndpoint(cache, mode, endpoint, locale)));
  return completeLocaleItems(snapshots, Object.assign({}, ...snapshots));
}

module.exports = { fetchApiTasks, fetchApiEntities, fetchApiLocales, fetchEnvelopeOnce };
