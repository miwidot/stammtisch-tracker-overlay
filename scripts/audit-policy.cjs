'use strict';

/**
 * Pure evaluation of an `npm audit --json` (report version 2) result against
 * reviewed, expiring advisory acceptances. The module performs no I/O so the
 * policy can be unit tested; scripts/audit-dependencies.cjs runs npm, prints
 * the result, and owns the accepted list.
 */

const AUDIT_LEVEL = 'high';
const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isBlockingSeverity(severity, level) {
  const rank = SEVERITIES.indexOf(severity);
  // An unknown severity blocks, so an npm report format change fails closed.
  return rank === -1 || rank >= SEVERITIES.indexOf(level);
}

function advisoryId(via) {
  const id = typeof via.url === 'string' ? via.url.split('/').pop() : '';
  return id || `npm-${via.source}`;
}

function isWellFormedVulnerability(vulnerability) {
  return isRecord(vulnerability) && Array.isArray(vulnerability.via);
}

function hasWellFormedVulnerabilities(report) {
  return (
    isRecord(report.vulnerabilities) &&
    Object.values(report.vulnerabilities).every(isWellFormedVulnerability)
  );
}

function parseJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

/**
 * Parses npm's stdout and rejects anything that is not a usable report.
 * `status` is npm's exit code: 1 is expected only when vulnerabilities exist.
 */
function readAuditReport(stdout, status) {
  const report = parseJson(stdout);
  if (!isRecord(report)) return { error: 'npm audit did not produce a JSON report.' };
  if (report.error) {
    return { error: `npm audit failed: ${report.error.summary ?? JSON.stringify(report.error)}` };
  }
  if (!hasWellFormedVulnerabilities(report)) {
    return { error: 'npm audit produced an unexpected report format.' };
  }
  if (status !== 0 && Object.keys(report.vulnerabilities).length === 0) {
    return { error: `npm audit exited with status ${status} without reporting vulnerabilities.` };
  }
  return { report };
}

function toAdvisory(vulnerability, via) {
  return {
    id: advisoryId(via),
    name: via.name,
    severity: via.severity,
    title: via.title,
    url: via.url,
    range: via.range,
    fixAvailable: vulnerability.fixAvailable,
  };
}

/** Advisory objects at or above `level`, deduplicated by advisory and package. */
function collectAdvisories(report, level) {
  const advisories = new Map();
  for (const vulnerability of Object.values(report.vulnerabilities)) {
    for (const via of vulnerability.via) {
      // String entries name another vulnerable package, which is reported on its own.
      if (!isRecord(via) || !isBlockingSeverity(via.severity, level)) continue;
      const advisory = toAdvisory(vulnerability, via);
      advisories.set(`${advisory.id}:${advisory.name}`, advisory);
    }
  }
  return [...advisories.values()];
}

function isValidDate(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

/** An entry is valid through its `expires` date (UTC) and fails after it. */
function expiryFailure(id, entry, today) {
  if (!isValidDate(entry.expires)) {
    return `Accepted advisory ${id} needs an expires date in YYYY-MM-DD form.`;
  }
  if (today > entry.expires) {
    return `Accepted advisory ${id} (${entry.package}) expired on ${entry.expires}; re-review it and renew or remove the entry.`;
  }
  return undefined;
}

function describeAdvisory(advisory) {
  return `${advisory.name} ${advisory.range} [${advisory.severity}] ${advisory.title} ${advisory.url}`;
}

function evaluateAdvisory(outcome, advisory, entry) {
  if (!entry || entry.package !== advisory.name) {
    outcome.failures.push(`Unaccepted advisory: ${describeAdvisory(advisory)}`);
    return;
  }
  if (advisory.fixAvailable === true) {
    outcome.failures.push(
      `npm reports a non-breaking fix for accepted advisory ${advisory.id} (${advisory.name}); update the dependency and remove the entry.`
    );
    return;
  }
  outcome.accepted.push(`Accepted ${advisory.id} (${entry.package}): ${entry.reason}`);
}

function evaluateEntries(outcome, accepted, matchedIds, today) {
  for (const [id, entry] of Object.entries(accepted)) {
    const failure = expiryFailure(id, entry, today);
    if (failure) outcome.failures.push(failure);
    if (!matchedIds.has(id)) {
      outcome.warnings.push(
        `Accepted advisory ${id} (${entry.package}) no longer matches a reported advisory; remove it from scripts/audit-dependencies.cjs.`
      );
    }
  }
}

/**
 * Evaluates a parsed audit report. `accepted` maps advisory ids (GHSA ids) to
 * `{ package, reason, expires }`; `today` is a UTC `YYYY-MM-DD` date. The audit
 * passes only when `failures` is empty.
 */
function evaluateAuditReport(report, accepted, today, level = AUDIT_LEVEL) {
  const outcome = { accepted: [], failures: [], warnings: [] };
  const matchedIds = new Set();
  for (const advisory of collectAdvisories(report, level)) {
    const entry = Object.hasOwn(accepted, advisory.id) ? accepted[advisory.id] : undefined;
    if (entry?.package === advisory.name) matchedIds.add(advisory.id);
    evaluateAdvisory(outcome, advisory, entry);
  }
  evaluateEntries(outcome, accepted, matchedIds, today);
  return outcome;
}

// A spawn error, signal, unparsable output, or npm audit error must never turn
// into a green check. npm exits 1 when it reports vulnerabilities, which the
// policy then evaluates; any other non-zero status is a failure.
function runFailure(result) {
  if (result.error) return result.error.message;
  if (result.signal) return `npm audit was terminated by ${result.signal}.`;
  if (result.status !== 0 && result.status !== 1) {
    return `npm audit exited with status ${result.status}.`;
  }
  return undefined;
}

function failClosed(...stderr) {
  return { exitCode: 1, stdout: [], stderr: stderr.filter(Boolean) };
}

function formatOutcome(outcome, level) {
  const stdout = [...outcome.accepted, ...outcome.warnings.map((line) => `::warning::${line}`)];
  if (outcome.failures.length === 0) {
    stdout.push(`No unaccepted advisories at or above ${level}.`);
    return { exitCode: 0, stdout, stderr: [] };
  }
  const stderr = [`Dependency audit failed (${outcome.failures.length}):`];
  return {
    exitCode: 1,
    stdout,
    stderr: stderr.concat(outcome.failures.map((line) => `- ${line}`)),
  };
}

/**
 * Turns a spawnSync result of `npm audit --json` into the launcher's exit code
 * and output lines. Only a parsed report without failures exits 0.
 */
function assessAuditRun(result, accepted, today, level = AUDIT_LEVEL) {
  const failure = runFailure(result);
  if (failure) return failClosed(failure);
  const parsed = readAuditReport(result.stdout, result.status);
  if (parsed.error) return failClosed(result.stdout, parsed.error);
  return formatOutcome(evaluateAuditReport(parsed.report, accepted, today, level), level);
}

module.exports = {
  AUDIT_LEVEL,
  assessAuditRun,
  evaluateAuditReport,
  readAuditReport,
};
