import { describe, expect, it } from 'vitest';
import { assessAuditRun, evaluateAuditReport, readAuditReport } from '../scripts/audit-policy.cjs';

const TODAY = '2026-10-04';
const BRACES_ID = 'GHSA-vfj7-8cjw-p6xm';

type Advisory = { id: string; name: string; severity: string };

function advisory({ id, name, severity }: Advisory) {
  return {
    source: 1,
    name,
    dependency: name,
    title: `${name} advisory`,
    url: `https://github.com/advisories/${id}`,
    severity,
    range: '*',
  };
}

function vulnerability(entry: Advisory, fixAvailable: unknown = false) {
  return { name: entry.name, severity: entry.severity, via: [advisory(entry)], fixAvailable };
}

const braces = { id: BRACES_ID, name: 'braces', severity: 'high' };

/** Mirrors the real report: the advisory object on braces, string edges upstream. */
function report(extra: Record<string, unknown> = {}, bracesFix: unknown = false) {
  return {
    auditReportVersion: 2,
    vulnerabilities: {
      braces: vulnerability(braces, bracesFix),
      micromatch: { name: 'micromatch', severity: 'high', via: ['braces'], fixAvailable: false },
      ...extra,
    },
  };
}

function accepted(expires = '2026-11-03') {
  return { [BRACES_ID]: { package: 'braces', reason: 'dev-only', expires } };
}

describe('evaluateAuditReport', () => {
  it('passes a report that contains only accepted advisories', () => {
    const outcome = evaluateAuditReport(report(), accepted(), TODAY);
    expect(outcome.failures).toEqual([]);
    expect(outcome.warnings).toEqual([]);
    expect(outcome.accepted).toEqual([`Accepted ${BRACES_ID} (braces): dev-only`]);
  });

  it('fails on an extra high advisory that is not accepted', () => {
    const extra = { id: 'GHSA-aaaa-bbbb-cccc', name: 'left-pad', severity: 'high' };
    const outcome = evaluateAuditReport(
      report({ 'left-pad': vulnerability(extra) }),
      accepted(),
      TODAY
    );
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]).toContain('GHSA-aaaa-bbbb-cccc');
  });

  it('fails when an accepted advisory id is reported for a different package', () => {
    const other = { id: BRACES_ID, name: 'not-braces', severity: 'high' };
    const outcome = evaluateAuditReport(
      report({ 'not-braces': vulnerability(other) }),
      accepted(),
      TODAY
    );
    expect(outcome.failures).toEqual([expect.stringContaining('not-braces')]);
  });

  it('fails once an accepted entry has expired', () => {
    const outcome = evaluateAuditReport(report(), accepted('2026-10-03'), TODAY);
    expect(outcome.failures).toEqual([expect.stringContaining('expired on 2026-10-03')]);
  });

  it('keeps an entry valid through its expiry date', () => {
    expect(evaluateAuditReport(report(), accepted(TODAY), TODAY).failures).toEqual([]);
  });

  it('fails on a malformed expiry date', () => {
    const outcome = evaluateAuditReport(report(), accepted('2026-13-40'), TODAY);
    expect(outcome.failures).toEqual([expect.stringContaining('expires date')]);
  });

  it('fails when npm reports a non-breaking fix for an accepted package', () => {
    const outcome = evaluateAuditReport(report({}, true), accepted(), TODAY);
    expect(outcome.failures).toEqual([expect.stringContaining('non-breaking fix')]);
    expect(outcome.accepted).toEqual([]);
  });

  it('keeps accepting when the only fix is a breaking downgrade', () => {
    const breaking = { name: 'markdownlint-cli2', version: '0.0.4', isSemVerMajor: true };
    expect(evaluateAuditReport(report({}, breaking), accepted(), TODAY).failures).toEqual([]);
  });

  it('passes moderate-only advisories that are not accepted', () => {
    const moderate = { id: 'GHSA-mmmm-mmmm-mmmm', name: 'ajv', severity: 'moderate' };
    const outcome = evaluateAuditReport(
      { auditReportVersion: 2, vulnerabilities: { ajv: vulnerability(moderate) } },
      {},
      TODAY
    );
    expect(outcome.failures).toEqual([]);
  });

  it('fails on critical and unknown severities', () => {
    const critical = { id: 'GHSA-cccc-cccc-cccc', name: 'a', severity: 'critical' };
    const unknown = { id: 'GHSA-uuuu-uuuu-uuuu', name: 'b', severity: 'severe' };
    const outcome = evaluateAuditReport(
      { vulnerabilities: { a: vulnerability(critical), b: vulnerability(unknown) } },
      {},
      TODAY
    );
    expect(outcome.failures).toHaveLength(2);
  });

  it('warns about an accepted entry that no longer matches a reported advisory', () => {
    const outcome = evaluateAuditReport(
      { auditReportVersion: 2, vulnerabilities: {} },
      accepted(),
      TODAY
    );
    expect(outcome.failures).toEqual([]);
    expect(outcome.warnings).toEqual([expect.stringContaining(`${BRACES_ID} (braces)`)]);
  });
});

describe('readAuditReport', () => {
  it('accepts a well-formed report with npm status 1', () => {
    expect(readAuditReport(JSON.stringify(report()), 1).report).toBeDefined();
  });

  it.each([
    ['unparsable output', 'npm ERR!', 1],
    ['an npm error object', JSON.stringify({ error: { summary: 'offline' } }), 1],
    ['a missing vulnerabilities object', JSON.stringify({ auditReportVersion: 2 }), 0],
    ['a vulnerability without via', JSON.stringify({ vulnerabilities: { a: {} } }), 1],
    ['status 1 without vulnerabilities', JSON.stringify({ vulnerabilities: {} }), 1],
  ])('rejects %s', (_label, stdout, status) => {
    expect(readAuditReport(stdout, status).error).toEqual(expect.any(String));
  });
});

describe('assessAuditRun', () => {
  const run = (overrides: Record<string, unknown>) => ({
    signal: null,
    status: 1,
    stdout: JSON.stringify(report()),
    ...overrides,
  });

  it('exits 0 and prints the acceptance for an accepted-only report', () => {
    const verdict = assessAuditRun(run({}), accepted(), TODAY);
    expect(verdict.exitCode).toBe(0);
    expect(verdict.stdout).toContain('No unaccepted advisories at or above high.');
    expect(verdict.stderr).toEqual([]);
  });

  it('prints stale entries as GitHub warnings', () => {
    const verdict = assessAuditRun(
      run({ status: 0, stdout: JSON.stringify({ vulnerabilities: {} }) }),
      accepted(),
      TODAY
    );
    expect(verdict.exitCode).toBe(0);
    expect(verdict.stdout[0]).toMatch(/^::warning::Accepted advisory GHSA-vfj7-8cjw-p6xm/);
  });

  it('exits 1 and lists failures', () => {
    const verdict = assessAuditRun(run({}), accepted('2026-10-01'), TODAY);
    expect(verdict.exitCode).toBe(1);
    expect(verdict.stderr).toEqual([
      'Dependency audit failed (1):',
      expect.stringContaining('- Accepted advisory GHSA-vfj7-8cjw-p6xm (braces) expired'),
    ]);
  });

  it.each([
    ['a spawn error', { error: new Error('spawn failed') }, 'spawn failed'],
    ['a signal', { signal: 'SIGKILL', status: null }, 'terminated by SIGKILL'],
    ['an unexpected status', { status: 2 }, 'exited with status 2'],
    ['unparsable output', { stdout: 'npm ERR!' }, 'did not produce a JSON report'],
  ])('fails closed on %s', (_label, overrides, message) => {
    const verdict = assessAuditRun(run(overrides), accepted(), TODAY);
    expect(verdict.exitCode).toBe(1);
    expect(verdict.stderr.join('\n')).toContain(message);
  });
});
