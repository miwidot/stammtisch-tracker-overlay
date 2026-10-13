"use strict";

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
  const match = findAddedEntity(upstream?.extracts, extract, "name");
  pushRow(section, [id, `extractsAdd:${extract.id}.presence`, formatValue(match), "addition",
    presenceStatus(match, available && !!upstream)]);
  const fields = { ...extract };
  delete fields.id;
  pushRow(section, [id, `extractsAdd:${extract.id}`, formatValue(match), formatValue(extract),
    comparisonStatus(fields, match, available)]);
}

function pushExtractAdditionRows(section, id, additions, upstream, available) {
  available = available && Array.isArray(upstream?.extracts);
  if (additions.length === 0) {
    pushRow(section, [id, "extractsAdd", formatValue(upstream?.extracts), "[]",
      guardedComparisonStatus([], [], available && !!upstream)]);
  }
  for (const extract of additions) pushExtractAdditionRow(section, id, extract, upstream, available);
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
  for (const [field, value] of Object.entries(patch || {})) {
    if (field === "extractsAdd" && Array.isArray(value)) {
      pushExtractAdditionRows(section, id, value, upstream, available);
    } else {
      pushRow(section, [id, field, formatValue(upstream?.[field]), formatValue(value),
        comparisonStatus(value, upstream?.[field], available)]);
    }
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
  const section = createSection(`${title} vs API`, ["Entity", "Field", "API", "Overlay", "Status"],
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
      const field = row[1].split(":")[0];
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
    apiTasks ? new Map(apiTasks.map((task) => [task.id, task])) : null, true, true);
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

function buildLocaleSections(locales = {}, locale) {
  const bundle = locales[locale] || {};
  const sections = [];

  for (const [entityType, entries] of Object.entries(bundle)) {
    if (!entries || typeof entries !== "object") {
      continue;
    }
    const section = createSection(`${entityType} (${locale})`, ["Entity", "Field", "Overlay"]);

    for (const [entityId, patch] of Object.entries(entries)) {
      if (!patch || typeof patch !== "object") {
        pushRow(section, [entityId, "value", formatValue(patch)]);
        continue;
      }
      for (const [field, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        if (field === "objectives" && value && typeof value === "object") {
          for (const [objectiveId, objectivePatch] of Object.entries(value)) {
            if (!objectivePatch || typeof objectivePatch !== "object") {
              continue;
            }
            for (const [objectiveField, objectiveValue] of Object.entries(objectivePatch)) {
              if (objectiveValue === undefined) continue;
              pushRow(section, [
                entityId,
                `objective:${objectiveId}.${objectiveField}`,
                formatValue(objectiveValue),
              ]);
            }
          }
          continue;
        }
        pushRow(section, [entityId, field, formatValue(value)]);
      }
    }

    if (section.rows.length > 0) {
      sections.push(section);
    }
  }

  if (sections.length === 0) {
    const empty = createSection(`Locale ${locale}`, ["Entity", "Field", "Overlay"]);
    pushRow(empty, ["(no corrections)", "-", "-"]);
    return [empty];
  }
  return sections;
}

function buildSeasonalPerkSections(perks = {}) {
  const section = createSection("Seasonal Perk Effects", ["Perk ID", "Raw Effects"]);
  for (const [id, perk] of Object.entries(perks)) {
    pushRow(section, [perk?.id || id, JSON.stringify(perk?.effects || [])]);
  }
  return [section];
}

function buildCraftAddSections(crafts = {}) {
  const section = createSection("Craft Additions", [
    "Craft",
    "ID",
    "Station",
    "Level",
    "Duration",
    "Product",
  ]);

  for (const [id, craft] of Object.entries(crafts)) {
    if (!craft || typeof craft !== "object") {
      pushRow(section, [id, id, "-", "-", "-", "-"]);
      continue;
    }
    const duration =
      typeof craft.duration === "number" ? `${Math.round(craft.duration / 60)} min` : "-";
    const product =
      craft.productItem && typeof craft.productItem === "object"
        ? craft.productItem.item || "-"
        : "-";
    pushRow(section, [
      craft.id || id,
      id,
      craft.station || "-",
      craft.level ?? "-",
      duration,
      product,
    ]);
  }

  return [section];
}

function guardedComparisonStatus(value, upstream, available, shared) {
  const status = comparisonStatus(value, upstream, available);
  return status === "same" && shared !== undefined && !valuesEqual(shared, value) ? "mode guard" : status;
}

function pushTaskFieldRows(section, taskName, override, apiTask, available, shared) {
  const { objectives, objectivesAdd, ...fields } = override;
  for (const [field, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    pushRow(section, [taskName, field, formatValue(apiTask[field]), formatValue(value),
      guardedComparisonStatus(value, apiTask[field], available, shared?.[field])]);
  }
}

function findApiObjective(objectives, id) {
  if (!validObjectiveCollection(objectives)) return undefined;
  return objectives.find((objective) => isEntityRecord(objective) && objective.id === id);
}

function pushObjectiveFields(section, taskName, objectiveId, patch, upstream, available, shared) {
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    pushRow(section, [taskName, `objective:${objectiveId}.${field}`, formatValue(upstream[field]), formatValue(value),
      guardedComparisonStatus(value, upstream[field], available, shared?.[field])]);
  }
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
  return objective.description || objective.id || "Added objective";
}

function objectiveComparisonFields(objective, upstream) {
  const fields = { ...objective };
  if (upstream?.id !== objective.id) delete fields.id;
  return fields;
}

function pushObjectiveAdditionRow(section, taskName, objective, apiTask, available) {
  const label = objectiveLabel(objective);
  const upstream = findAddedEntity(apiTask.objectives, objective, "description");
  pushRow(section, [taskName, label, formatValue(objective), formatValue(upstream),
    comparisonStatus(objectiveComparisonFields(objective, upstream), upstream, available)]);
  pushRow(section, [taskName, `${label} (presence)`, "addition", upstream ? "present" : "missing",
    presenceStatus(upstream, available && !!apiTask.id)]);
}

function pushObjectiveAdditionRows(section, taskName, additions, apiTask, available) {
  if (!Array.isArray(additions)) return;
  available = available && validObjectiveCollection(apiTask.objectives);
  for (const objective of additions) {
    pushObjectiveAdditionRow(section, taskName, objective, apiTask, available);
  }
}

function buildTasksSections(overrides = {}, apiTasks = [], available = true, shared = {}) {
  const diffSection = createSection("Task Overrides vs API", ["Task", "Field", "API", "Overlay", "Status"], { statusColumnIndex: 4 });
  const objectivesAddSection = createSection("Added Objectives", ["Task", "Objective", "Overlay", "API", "Status"], { statusColumnIndex: 4 });
  const missingSection = createSection("Tasks Missing From API", ["Task", "Task ID", "Status"], { statusColumnIndex: 2 });
  const disabledSection = createSection("Disabled Tasks", ["Task", "Task ID"]);
  const apiById = new Map(apiTasks.map((task) => [task.id, task]));
  for (const [taskId, override] of Object.entries(overrides)) {
    if (!override || typeof override !== "object") continue;
    const apiTask = apiById.get(taskId) || {};
    const taskName = apiTask.name || override.name || `Task ID ${taskId}`;
    if (!apiTask.id) pushRow(missingSection, [taskName, taskId, "unverified"]);
    if (override.disabled === true) pushRow(disabledSection, [taskName, taskId]);
    pushTaskFieldRows(diffSection, taskName, override, apiTask, available, shared[taskId]);
    pushObjectiveOverrideRows(diffSection, taskName, override.objectives, apiTask, available, shared[taskId]);
    pushObjectiveAdditionRows(objectivesAddSection, taskName, override.objectivesAdd, apiTask, available);
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
