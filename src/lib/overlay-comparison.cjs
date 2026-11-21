'use strict';

// Objects patch supplied fields; arrays replace collections and ignore upstream ordering.
const IDENTITY_KEYS = ['id', 'item', 'effectId'];
const PRIORITY = ['invalid', 'different', 'unverified', 'same'];

function isRecord(value) {
  if (value === null || typeof value !== 'object') return false;
  return Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null;
}

function isScalar(value) {
  return (
    value === null ||
    ['string', 'boolean'].includes(typeof value) ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

function property(value, key) {
  if (!isRecord(value)) return undefined;
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

function childPath(path, key) {
  return path ? `${path}.${key}` : key;
}

function detail(path, overlayValue, upstreamValue, status, reason) {
  return { field: path || '(root)', status, overlayValue, upstreamValue, reason };
}

function combinedStatus(rows) {
  return PRIORITY.find((status) => rows.some((row) => row.status === status)) || 'same';
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function identityValue(value) {
  if (typeof value === 'string' && value.length) return `string:${value}`;
  if (finiteNumber(value)) return `number:${value}`;
  return undefined;
}

function entryIdentity(entry, key) {
  const value = property(entry, key);
  return identityValue(isRecord(value) ? property(value, 'id') : value);
}

function identities(entries, key) {
  return entries.map((entry) => entryIdentity(entry, key));
}

function completeIdentities(ids) {
  return ids.length > 0 && ids.every((id) => id !== undefined);
}

function uniqueIdentities(ids) {
  return completeIdentities(ids) && new Set(ids).size === ids.length;
}

function arrayIdentity(overlay, upstream) {
  return IDENTITY_KEYS.find(
    (key) =>
      completeIdentities(identities(overlay, key)) && completeIdentities(identities(upstream, key))
  );
}

function canonical(value, ancestors = new Set()) {
  if (isScalar(value)) return JSON.stringify(value);
  if (ancestors.has(value)) throw new Error('Circular value');
  const next = new Set(ancestors).add(value);
  if (Array.isArray(value))
    return `[${Array.from(value, (entry) => canonical(entry, next))
      .sort()
      .join(',')}]`;
  return canonicalRecord(value, next);
}

function canonicalRecord(value, ancestors) {
  if (!isRecord(value)) throw new Error('Non-JSON value');
  return canonicalObject(value, ancestors);
}

function canonicalObject(value, ancestors) {
  const entries = Object.keys(value)
    .sort()
    .filter((key) => value[key] !== undefined);
  return `{${entries.map((key) => `${JSON.stringify(key)}:${canonical(value[key], ancestors)}`).join(',')}}`;
}

function exactKey(value) {
  try {
    return canonical(value);
  } catch {
    return undefined;
  }
}

function scalarRows(path, overlay, upstream) {
  if (!isScalar(overlay))
    return [detail(path, overlay, upstream, 'invalid', 'Overlay value is not valid JSON')];
  if (upstream === undefined)
    return [detail(path, overlay, upstream, 'unverified', 'Field is absent upstream')];
  const same = overlay === upstream;
  return [detail(path, overlay, upstream, same ? 'same' : 'different', scalarReason(same))];
}

function scalarReason(same) {
  return same ? 'Values agree' : 'Values differ';
}

function excluded(path, options) {
  return (options.ignoreFields || []).includes(path);
}

function annotate(rows, path, options) {
  if (!(options.identityFields || []).includes(path)) return rows;
  return rows.map((row) => ({ ...row, reason: `${row.reason}; identity field, not a correction` }));
}

function unavailableChildren(overlay, path, context, reason) {
  return childRows(overlay, undefined, path, context).map((row) => {
    if (row.status === 'invalid') return row;
    return { ...row, status: 'unverified', reason };
  });
}

function childRows(overlay, upstream, path, context) {
  if (Array.isArray(overlay)) {
    return overlay.flatMap((value, index) =>
      compareNode(value, undefined, `${path}[${index}]`, context)
    );
  }
  return Object.entries(overlay).flatMap(([key, value]) =>
    compareNode(value, property(upstream, key), childPath(path, key), context)
  );
}

function container(path, overlay, upstream, rows, status, reason) {
  const childStatus = combinedStatus(rows);
  const resolved = containerStatus(status, childStatus);
  return [
    detail(path, overlay, upstream, resolved, reason || `Supplied fields are ${resolved}`),
    ...rows,
  ];
}

function containerStatus(status, childStatus) {
  if (childStatus === 'invalid') return 'invalid';
  return status || childStatus;
}

function incompatible(overlay, upstream, path, context) {
  const missing = upstream === undefined;
  const reason = missing ? 'Field is absent upstream' : 'Container types differ';
  const children = unavailableChildren(overlay, path, context, reason);
  return container(path, overlay, upstream, children, missing ? 'unverified' : 'different', reason);
}

function dictionaryIdentity(upstream) {
  return IDENTITY_KEYS.find((field) =>
    upstream.some((entry) => entryIdentity(entry, field) !== undefined)
  );
}

function dictionaryMatch(upstream, key) {
  const identity = dictionaryIdentity(upstream);
  if (!identity) return { reason: 'Upstream collection has no canonical identity' };
  const matches = upstream.filter((entry) => entryIdentity(entry, identity) === identityValue(key));
  if (matches.length === 1) return { value: matches[0] };
  return {
    reason: matches.length ? 'Upstream identity is ambiguous' : 'Keyed record is absent upstream',
  };
}

function dictionaryRows(overlay, upstream, path, context) {
  return Object.entries(overlay).flatMap(([key, value]) => {
    const match = dictionaryMatch(upstream, key);
    const rows = compareNode(value, match.value, childPath(path, key), context);
    if (!match.reason) return rows;
    return rows.map((row) =>
      row.status === 'invalid' ? row : { ...row, status: 'unverified', reason: match.reason }
    );
  });
}

function objectRows(overlay, upstream, path, context) {
  if (Array.isArray(upstream) && Object.keys(overlay).length) {
    return container(path, overlay, upstream, dictionaryRows(overlay, upstream, path, context));
  }
  if (!isRecord(upstream)) return incompatible(overlay, upstream, path, context);
  return container(path, overlay, upstream, childRows(overlay, upstream, path, context));
}

function identifiedRows(overlay, upstream, path, context, key) {
  const upstreamMap = new Map(upstream.map((entry) => [entryIdentity(entry, key), entry]));
  const rows = overlay.flatMap((entry, index) =>
    compareNode(entry, upstreamMap.get(entryIdentity(entry, key)), `${path}[${index}]`, context)
  );
  const missing = overlay.some((entry) => !upstreamMap.has(entryIdentity(entry, key)));
  const changed = missing || overlay.length !== upstream.length;
  return container(
    path,
    overlay,
    upstream,
    rows,
    changed ? 'different' : undefined,
    changed ? 'Array membership or cardinality differs' : undefined
  );
}

function exactArrayRows(overlay, upstream, path, context) {
  const keys = upstream.map(exactKey);
  const used = new Set();
  const rows = overlay.flatMap((entry, index) => {
    const target = keys.findIndex(
      (key, candidate) => key !== undefined && !used.has(candidate) && key === exactKey(entry)
    );
    if (target < 0) return unavailableEntry(entry, path, index, context);
    used.add(target);
    return compareNode(entry, upstream[target], `${path}[${index}]`, context);
  });
  const equal = exactKey(overlay) !== undefined && exactKey(overlay) === exactKey(upstream);
  return container(
    path,
    overlay,
    upstream,
    rows,
    equal ? undefined : 'different',
    equal
      ? undefined
      : 'Array membership or cardinality differs; unmatched entries cannot be aligned'
  );
}

function unavailableEntry(entry, path, index, context) {
  return compareNode(entry, undefined, `${path}[${index}]`, context).map((row) =>
    row.status === 'invalid'
      ? row
      : { ...row, status: 'unverified', reason: 'Array entry cannot be safely aligned upstream' }
  );
}

function denseArray(value) {
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) return false;
  }
  return true;
}

function sparseArrayRows(overlay, upstream, path, context) {
  if (!denseArray(overlay))
    return [detail(path, overlay, upstream, 'invalid', 'Sparse overlay array is not valid JSON')];
  if (Array.isArray(upstream) && !denseArray(upstream)) {
    return container(
      path,
      overlay,
      upstream,
      unavailableChildren(overlay, path, context, 'Sparse upstream array cannot be verified'),
      'unverified',
      'Sparse upstream array cannot be verified'
    );
  }
  return undefined;
}

function arrayRows(overlay, upstream, path, context) {
  const sparse = sparseArrayRows(overlay, upstream, path, context);
  if (sparse) return sparse;
  return denseArrayRows(overlay, upstream, path, context);
}

function denseArrayRows(overlay, upstream, path, context) {
  if (!Array.isArray(upstream)) return incompatible(overlay, upstream, path, context);
  const key = arrayIdentity(overlay, upstream);
  if (!key) return exactArrayRows(overlay, upstream, path, context);
  return keyedArrayRows(overlay, upstream, path, context, key);
}

function keyedArrayRows(overlay, upstream, path, context, key) {
  if (uniqueIdentities(identities(overlay, key)) && uniqueIdentities(identities(upstream, key))) {
    return identifiedRows(overlay, upstream, path, context, key);
  }
  return ambiguousArrayRows(overlay, upstream, path, context);
}

function ambiguousArrayRows(overlay, upstream, path, context) {
  const rows = unavailableChildren(
    overlay,
    path,
    context,
    'Repeated array identities prevent safe alignment'
  );
  const sameLength = overlay.length === upstream.length;
  return container(
    path,
    overlay,
    upstream,
    rows,
    sameLength ? 'unverified' : 'different',
    sameLength ? 'Repeated array identities prevent safe alignment' : 'Array cardinality differs'
  );
}

function compareContainer(overlay, upstream, path, context) {
  if (context.ancestors.has(overlay)) {
    return [detail(path, overlay, upstream, 'invalid', 'Circular overlay value')];
  }
  const next = { ...context, ancestors: new Set(context.ancestors).add(overlay) };
  return Array.isArray(overlay)
    ? arrayRows(overlay, upstream, path, next)
    : objectRows(overlay, upstream, path, next);
}

function compareNode(overlay, upstream, path, context) {
  if (overlay === undefined) return [];
  if (excluded(path, context.options)) return excludedRows(overlay, upstream, path, context);
  const rows = compareDefinedNode(overlay, upstream, path, context);
  return annotate(rows, path, context.options);
}

function compareDefinedNode(overlay, upstream, path, context) {
  if (isRecord(overlay) || Array.isArray(overlay))
    return compareContainer(overlay, upstream, path, context);
  return scalarRows(path, overlay, upstream);
}

function excludedRows(overlay, upstream, path, context) {
  const options = { ...context.options, ignoreFields: [] };
  return compareNode(overlay, upstream, path, { ...context, options }).map((row) => ({
    ...row,
    status: 'unverified',
    reason: 'Explicitly excluded metadata; equality is not verified',
  }));
}

function compareOverlayFields(patch, upstream, options = {}) {
  const context = { options, ancestors: new Set() };
  const rows = compareNode(patch, upstream, '', context);
  // Root objects describe records, so only their supplied fields need reporting.
  if (isRecord(patch) && Object.keys(patch).length) return rows.slice(1);
  return rows;
}

function comparisonSummary(details) {
  const summary = { same: 0, different: 0, unverified: 0, invalid: 0 };
  for (const row of details) summary[row.status] += 1;
  return summary;
}

module.exports = { compareOverlayFields, comparisonSummary };
