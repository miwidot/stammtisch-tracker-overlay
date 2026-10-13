"use strict";

const { comparisonTask } = require("../../src/lib/task-comparison.cjs");
const { compareOverlayFields } = require("../../src/lib/overlay-comparison.cjs");
const { config, getModeLabel } = require("./config.js");
const { mergeTaskOverride, selectTaskAdditions, validObjectiveCollection } = require("../../src/lib/tarkov-api-shared.cjs");

function createSection(title, columns, options = {}) {
  return {
    ...options,
    title,
    columns,
    rows: [],
    truncated: false,
  };
}

function pushRow(section, row) {
  if (section.rows.length >= config.maxRows) {
    section.truncated = true;
    return;
  }
  section.rows.push(row);
}

function normalizeCompareValue(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeCompareValue).sort((a, b) => String(JSON.stringify(a)).localeCompare(String(JSON.stringify(b))));
  }

  if (value && typeof value === "object") {
    const normalized = {};
    for (const key of Object.keys(value).sort()) {
      normalized[key] = normalizeCompareValue(value[key]);
    }
    return normalized;
  }

  return value;
}

function valuesEqual(a, b) {
  if (a === undefined && b === undefined) return true;
  return JSON.stringify(normalizeCompareValue(a)) === JSON.stringify(normalizeCompareValue(b));
}

// Object patches compare only supplied keys; arrays replace and compare without order.
function compareSubset(overlay, upstream) {
  if (overlay === undefined) return true;
  if (!overlay || typeof overlay !== "object" || Array.isArray(overlay)) {
    return valuesEqual(overlay, upstream);
  }
  return !!upstream && typeof upstream === "object" && !Array.isArray(upstream) &&
    Object.keys(overlay).every((key) => compareSubset(overlay[key], upstream[key]));
}

function comparisonStatus(value, upstream, available) {
  if (!available || upstream === undefined) return "unverified";
  return compareSubset(value, upstream) ? "same" : "needs evidence";
}

function pushExtractAdditionRow(section, id, extract, upstream, available) {
  if (!isEntityRecord(extract)) {
    pushRow(section, [id, "extractsAdd", "unknown", formatValue(extract), "unverified"]);
    return;
  }
  const match = extractMatch(upstream, extract, available);
  pushRow(section, [id, `extractsAdd:${extract.id}.presence`, formatValue(match), "addition",
    presenceStatus(match, available)]);
  const fields = { ...extract };
  delete fields.id;
  pushRow(section, [id, `extractsAdd:${extract.id}`, formatValue(match), formatValue(extract),
    comparisonVerdict(compareOverlayFields(fields, match))]);
  pushExtractFieldRows(section, id, extract, match);
}

function extractMatch(upstream, extract, available) {
  if (!available) return undefined;
  return findAddedEntity(upstream.extracts, extract, "name");
}

function pushExtractFieldRows(section, id, extract, upstream) {
  for (const detail of compareOverlayFields(extract, upstream, { identityFields: ["id"] })) {
    const status = detail.status === "different" ? "needs evidence" : detail.status;
    pushRow(section, [id, `extractsAdd:${extract.id}.${detail.field}`, formatValue(detail.upstreamValue), formatValue(detail.overlayValue), status, detail.reason]);
  }
}

function pushExtractAdditionRows(section, id, additions, upstream, available) {
  available = extractCollectionAvailable(upstream, available);
  if (additions.length === 0) pushEmptyExtractAdditionRow(section, id, upstream, available);
  for (const extract of additions) pushExtractAdditionRow(section, id, extract, upstream, available);
}

function extractCollectionAvailable(upstream, available) {
  return available && validObjectiveCollection(upstream?.extracts);
}

function pushEmptyExtractAdditionRow(section, id, upstream, available) {
  pushRow(section, [id, "extractsAdd", formatValue(upstream?.extracts), "[]",
    guardedComparisonStatus([], [], available)]);
}

function isEntityRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function findAddedEntity(entries = [], addition, nameField) {
  if (!Array.isArray(entries)) return undefined;
  entries = entries.filter((entry) => entry && typeof entry === "object");
  const exact = entries.find((entry) => entry.id === addition.id);
  if (exact) return exact;
  const names = entries.filter((entry) => addition[nameField] && entry[nameField] === addition[nameField]);
  return names.length === 1 ? names[0] : undefined;
}

function presenceStatus(upstream, available) {
  if (!available) return "unverified";
  return upstream ? "already upstream" : "missing upstream";
}

function pushEntityFieldRows(section, id, patch, upstream, available) {
  if (!isEntityRecord(patch)) {
    pushRow(section, [id, "entity", "unknown", formatValue(patch), "unverified"]);
    return;
  }
  const fields = { ...patch };
  if (Array.isArray(fields.extractsAdd)) {
    pushExtractAdditionRows(section, id, fields.extractsAdd, upstream, available);
    delete fields.extractsAdd;
  }
  if (Object.keys(fields).length === 0) return;
  for (const detail of compareOverlayFields(fields, available ? upstream : undefined, { identityFields: ["id"] })) {
    const status = detail.status === "different" ? "needs evidence" : detail.status;
    pushRow(section, [id, detail.field, formatValue(detail.upstreamValue), formatValue(detail.overlayValue), status, detail.reason]);
  }
}

function findTaskCandidate(apiEntities, patch) {
  const entries = [...apiEntities.values()];
  const wikiMatches = entries.filter((entry) => patch.wikiLink && entry.wikiLink === patch.wikiLink);
  if (wikiMatches.length === 1) return { upstream: wikiMatches[0], status: "already upstream" };
  const names = entries.filter((entry) => patch.name && entry.name === patch.name);
  if (names.length) return { upstream: undefined, status: "name candidate" };
  return { upstream: undefined, status: "missing upstream" };
}

function findEntityMatch(apiEntities, id, key, patch, taskCandidates) {
  if (!apiEntities) return { upstream: undefined, status: "unverified" };
  const upstream = apiEntities.get(id) || apiEntities.get(key);
  if (upstream) return { upstream, status: "already upstream" };
  if (taskCandidates && isEntityRecord(patch)) return findTaskCandidate(apiEntities, patch);
  return { upstream: undefined, status: "missing upstream" };
}

function buildEntityComparisonSections(title, overrides = {}, apiEntities, additions = false, taskCandidates = false) {
  const section = createSection(`${title} vs API`, ["Entity", "Field", "API", "Overlay", "Status", "Reason"],
    { statusColumnIndex: 4 });
  for (const [key, patch] of Object.entries(overrides)) {
    const id = additions ? patch?.id || key : key;
    const match = findEntityMatch(apiEntities, id, additions ? key : id, patch, taskCandidates);
    const upstream = match.upstream;
    if (additions) {
      pushRow(section, [id, "entity", upstream ? "present" : "missing", "addition", match.status]);
    }
    pushEntityFieldRows(section, id, patch, upstream, !!apiEntities);
  }
  return [section];
}

function markModeGuards(sections, shared, effective) {
  for (const section of sections) {
    if (section.statusColumnIndex === undefined) continue;
    for (const row of section.rows) {
      if (row[section.statusColumnIndex] !== "same") continue;
      const field = row[1].split(/[:.\[]/)[0];
      if (shared[row[0]]?.[field] !== undefined &&
          !valuesEqual(shared[row[0]][field], effective[row[0]]?.[field])) {
        row[section.statusColumnIndex] = "mode guard";
      }
    }
  }
  return sections;
}

function formatValue(value, maxLength = 220) {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  const json = JSON.stringify(value);
  if (!json) return String(value);
  if (json.length <= maxLength) return json;
  return `${json.slice(0, maxLength - 1)}…`;
}

function mergeTaskOverrides(shared = {}, modeSpecific = {}) {
  const entries = Object.entries(shared);
  for (const [taskId, override] of Object.entries(modeSpecific)) {
    const sharedOverride = Object.prototype.hasOwnProperty.call(shared, taskId)
      ? shared[taskId]
      : undefined;
    entries.push([taskId, mergeTaskOverride(sharedOverride, override)]);
  }
  return Object.fromEntries(entries);
}

function mergeTaskAdditions(shared = {}, modeSpecific = {}) {
  return Object.fromEntries(selectTaskAdditions(shared, modeSpecific, true));
}

function buildOverrideSections(title, overrides = {}) {
  const section = createSection(`${title} Overrides`, ["Entity", "Field", "Overlay"]);

  for (const [entityId, override] of Object.entries(overrides)) {
    if (!override || typeof override !== "object") {
      pushRow(section, [entityId, "value", formatValue(override)]);
      continue;
    }
    const entries = Object.entries(override);
    if (entries.length === 0) {
      pushRow(section, [entityId, "(empty)", "{}"]);
      continue;
    }
    for (const [field, value] of entries) {
      pushRow(section, [entityId, field, formatValue(value)]);
    }
  }

  return [section];
}

function buildEditionsSections(editions = {}) {
  const section = createSection("Editions", [
    "Edition",
    "ID",
    "Stash",
    "Rep Bonus",
    "Exclusive Tasks",
    "Excluded Tasks",
  ]);

  for (const [key, edition] of Object.entries(editions)) {
    if (!edition || typeof edition !== "object") {
      pushRow(section, [key, key, "-", "-", "-", "-"]);
      continue;
    }
    const repCount = edition.traderRepBonus ? Object.keys(edition.traderRepBonus).length : 0;
    const exclusiveCount = Array.isArray(edition.exclusiveTaskIds)
      ? edition.exclusiveTaskIds.length
      : 0;
    const excludedCount = Array.isArray(edition.excludedTaskIds)
      ? edition.excludedTaskIds.length
      : 0;
    pushRow(section, [
      edition.title || key,
      edition.id || key,
      edition.defaultStashLevel ?? "-",
      repCount ? `${repCount} traders` : "-",
      exclusiveCount || "-",
      excludedCount || "-",
    ]);
  }

  return [section];
}

function buildStoryChapterSections(chapters = {}) {
  const section = createSection("Story Chapters", ["Chapter", "ID", "Order", "Objectives", "Wiki"]);

  for (const [key, chapter] of Object.entries(chapters)) {
    if (!chapter || typeof chapter !== "object") {
      pushRow(section, [key, key, "-", "-", "-"]);
      continue;
    }
    const objectiveCount = Array.isArray(chapter.objectives) ? chapter.objectives.length : 0;
    pushRow(section, [
      chapter.name || key,
      chapter.id || key,
      chapter.order ?? "-",
      objectiveCount,
      chapter.wikiLink || "-",
    ]);
  }

  return [section];
}

function buildTaskAdditionSections(tasksAdd = {}, mode, apiTasks) {
  return buildEntityComparisonSections(`Task Additions (${getModeLabel(mode)})`, tasksAdd,
    apiTasks ? new Map(apiTasks.map((task) => [task.id, comparisonTask(task)])) : null, true, true);
}

function buildPrestigeSections(prestige = {}) {
  const section = createSection("Prestige Levels", [
    "Level",
    "ID",
    "Name",
    "Conditions",
    "Story Requirements",
  ]);

  for (const [id, entry] of Object.entries(prestige)) {
    if (!entry || typeof entry !== "object") {
      pushRow(section, ["-", id, "-", "-", "-"]);
      continue;
    }
    const conditionsCount = entry.conditions ? Object.keys(entry.conditions).length : 0;
    const storyRequirements = Array.isArray(entry.storyRequirements) ? entry.storyRequirements : [];
    const storySummary =
      storyRequirements.length > 0
        ? storyRequirements.map((req) => req.name || req.storyChapter).join("; ")
        : "-";
    pushRow(section, [
      entry.prestigeLevel ?? "-",
      entry.id || id,
      entry.name || "-",
      conditionsCount || "-",
      storySummary,
    ]);
  }

  return [section];
}

function localeComparisonIndex(entityType, upstream) {
  const supportedFields = {
    tasks: ["name", "wikiLink", "objectives"], items: ["name", "shortName", "description", "wikiLink"],
    questItems: ["name", "shortName", "description"], traders: ["name", "description"],
    maps: ["name", "description"], prestige: ["name"],
  }[entityType] || [];
  if (!upstream) return undefined;
  return new Map([...upstream].map(([id, record]) => [id, localeRecord(record, supportedFields)]));
}

function localeRecord(record, supportedFields) {
  const filtered = Object.fromEntries(Object.entries(record).filter(([field]) => supportedFields.includes(field)));
  if (Array.isArray(filtered.objectives)) filtered.objectives = filtered.objectives.map(localeObjective);
  return filtered;
}

function localeObjective(objective) {
  if (!isEntityRecord(objective)) return objective;
  return { id: objective.id, description: objective.description };
}

function localeEntitySections(entityType, entries, locale, upstream) {
  const title = `${entityType} (${locale})`;
  if (isEntityRecord(entries)) return buildEntityComparisonSections(title, entries, localeComparisonIndex(entityType, upstream));
  const section = createSection(title, ["Entity", "Field", "API", "Overlay", "Status", "Reason"], { statusColumnIndex: 4 });
  pushRow(section, [entityType, "entity", "undefined", formatValue(entries), "invalid", "Expected an ID-keyed locale entity collection"]);
  return [section];
}

function buildLocaleSections(locales = {}, locale, upstream) {
  const bundle = locales[locale] || {};
  const sections = Object.entries(bundle).flatMap(([entityType, entries]) =>
    localeEntitySections(entityType, entries, locale, upstream?.[entityType]));
  if (sections.some(section => section.rows.length)) return sections;
  const empty = createSection(`Locale ${locale}`, ["Entity", "Field", "API", "Overlay", "Status"]);
  pushRow(empty, ["(no corrections)", "-", "-", "-", "unverified"]);
  return [empty];
}

function buildSeasonalPerkSections(perks = {}, upstream) {
  return buildEntityComparisonSections("Seasonal Perk Effects", perks, upstream);
}

function buildCraftAddSections(crafts = {}, upstream) {
  return buildEntityComparisonSections("Craft Additions", crafts, upstream, true);
}

function guardedComparisonStatus(value, upstream, available, shared) {
  const status = comparisonStatus(value, upstream, available);
  return status === "same" && shared !== undefined && !valuesEqual(shared, value) ? "mode guard" : status;
}

function detailStatus(detail, shared) {
  const status = detail.status === "different" ? "needs evidence" : detail.status;
  if (status !== "same") return status;
  return sharedDetailStatus(detail, shared, status);
}

function sharedDetailStatus(detail, shared, status) {
  const previous = shared.get(detail.field);
  if (previous === undefined) return status;
  return valuesEqual(previous, detail.overlayValue) ? status : "mode guard";
}

function pushComparisonRows(section, label, patch, upstream, available, shared, prefix = "") {
  const prior = new Map(compareOverlayFields(patch, shared).map(detail => [detail.field, detail.upstreamValue]));
  for (const detail of compareOverlayFields(patch, available ? upstream : undefined)) {
    pushRow(section, [label, `${prefix}${detail.field}`, formatValue(detail.upstreamValue), formatValue(detail.overlayValue), detailStatus(detail, prior), detail.reason]);
  }
}

function pushTaskFieldRows(section, taskName, override, apiTask, available, shared) {
  const { objectives, objectivesAdd, ...fields } = override;
  if (Object.keys(fields).length) pushComparisonRows(section, taskName, fields, apiTask, available, shared);
}

function findApiObjective(objectives, id) {
  if (!validObjectiveCollection(objectives)) return undefined;
  return objectives.find((objective) => isEntityRecord(objective) && objective.id === id);
}

function pushObjectiveFields(section, taskName, objectiveId, patch, upstream, available, shared) {
  pushComparisonRows(section, taskName, patch, upstream, available, shared, `objective:${objectiveId}.`);
}

function pushObjectiveOverrideRow(section, taskName, objectiveId, patch, apiTask, available, shared) {
  if (!isEntityRecord(patch)) return;
  const upstream = findApiObjective(apiTask.objectives, objectiveId);
  if (!upstream) {
    pushRow(section, [taskName, `objective:${objectiveId}`, "missing", formatValue(patch), "unverified"]);
    return;
  }
  pushObjectiveFields(section, taskName, objectiveId, patch, upstream, available, shared?.objectives?.[objectiveId]);
}

function pushObjectiveOverrideRows(section, taskName, objectives, apiTask, available, shared) {
  for (const [objectiveId, patch] of Object.entries(objectives || {})) {
    pushObjectiveOverrideRow(section, taskName, objectiveId, patch, apiTask, available, shared);
  }
}

function objectiveLabel(objective) {
  return objective?.description || objective?.id || "Added objective";
}

function comparisonVerdict(details) {
  if (details.some(detail => detail.status === "invalid")) return "invalid";
  if (details.some(detail => detail.status === "different")) return "needs evidence";
  if (details.some(detail => detail.status === "unverified")) return "unverified";
  return "same";
}

function objectiveMatch(apiTask, objective, available) {
  if (!available || !isEntityRecord(objective)) return { upstream: undefined, status: "unverified" };
  const exact = findApiObjective(apiTask.objectives, objective.id);
  if (exact) return { upstream: exact, status: "already upstream" };
  return objectiveCandidate(apiTask, objective);
}

function objectiveCandidate(apiTask, objective) {
  const candidate = findAddedEntity(apiTask.objectives, objective, "description");
  return { upstream: candidate, status: candidate ? "description candidate" : "missing upstream" };
}

function pushObjectiveAdditionRow(section, taskName, objective, apiTask, available) {
  const label = objectiveLabel(objective);
  const match = objectiveMatch(apiTask, objective, available);
  const details = compareOverlayFields(objective, match.upstream, { identityFields: ["id"] });
  pushRow(section, [taskName, label, formatValue(objective), formatValue(match.upstream), comparisonVerdict(details)]);
  pushRow(section, [taskName, `${label} (presence)`, "addition", match.upstream ? "present" : "missing", match.status]);
  for (const detail of details) {
    pushRow(section, [taskName, `${label}.${detail.field}`, formatValue(detail.overlayValue), formatValue(detail.upstreamValue), detailStatus(detail, new Map()), detail.reason]);
  }
}

function pushObjectiveAdditionRows(section, taskName, additions, apiTask, available) {
  if (!Array.isArray(additions)) return;
  available = available && validObjectiveCollection(apiTask.objectives);
  for (const objective of additions) {
    pushObjectiveAdditionRow(section, taskName, objective, apiTask, available);
  }
}

function buildTasksSections(overrides = {}, apiTasks = [], available = true, shared = {}) {
  const diffSection = createSection("Task Overrides vs API", ["Task", "Field", "API", "Overlay", "Status", "Reason"], { statusColumnIndex: 4 });
  const objectivesAddSection = createSection("Added Objectives", ["Task", "Objective", "Overlay", "API", "Status", "Reason"], { statusColumnIndex: 4 });
  const missingSection = createSection("Tasks Missing From API", ["Task", "Task ID", "Status"], { statusColumnIndex: 2 });
  const disabledSection = createSection("Disabled Tasks", ["Task", "Task ID"]);
  const apiById = new Map(apiTasks.map((task) => [task.id, task]));
  for (const [taskId, override] of Object.entries(overrides)) {
    if (!override || typeof override !== "object") continue;
    const apiTask = apiById.get(taskId) || {};
    const taskName = apiTask.name || override.name || `Task ID ${taskId}`;
    if (!apiTask.id) pushRow(missingSection, [taskName, taskId, "unverified"]);
    if (override.disabled === true) pushRow(disabledSection, [taskName, taskId]);
    const comparable = comparisonTask(apiTask);
    pushTaskFieldRows(diffSection, taskName, override, comparable, available, shared[taskId]);
    pushObjectiveOverrideRows(diffSection, taskName, override.objectives, comparable, available, shared[taskId]);
    pushObjectiveAdditionRows(objectivesAddSection, taskName, override.objectivesAdd, comparable, available);
  }
  return [diffSection, objectivesAddSection, missingSection, disabledSection];
}

module.exports = {
  markModeGuards,
  buildEntityComparisonSections,
  buildCraftAddSections,
  buildEditionsSections,
  buildLocaleSections,
  buildOverrideSections,
  buildPrestigeSections,
  buildSeasonalPerkSections,
  buildStoryChapterSections,
  buildTaskAdditionSections,
  buildTasksSections,
  createSection,
  formatValue,
  mergeTaskAdditions,
  mergeTaskOverrides,
  pushRow,
  valuesEqual,
};
