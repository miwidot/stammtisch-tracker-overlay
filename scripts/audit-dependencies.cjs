'use strict';

const { spawnSync } = require('node:child_process');
const { AUDIT_LEVEL, assessAuditRun } = require('./audit-policy.cjs');

// Audits every dependency (dev included) at AUDIT_LEVEL and fails on any
// advisory that is not reviewed and accepted below. Each entry names the
// affected package, explains why the advisory does not apply, and expires: an
// expired entry fails the audit until it is re-reviewed. An entry that no
// longer matches a reported advisory produces a warning to remove it, and a
// non-breaking fix reported by npm for an accepted package fails the audit so
// the dependency is updated instead.
const ACCEPTED_ADVISORIES = {
  'GHSA-vfj7-8cjw-p6xm': {
    package: 'braces',
    reason:
      'No patched braces release exists (braces <= 3.0.3). It is reached only through the ' +
      'markdownlint-cli2 devDependency (markdownlint-cli2 -> micromatch -> braces), where it ' +
      'expands glob patterns built from repo-controlled config and CLI arguments during lint. ' +
      'Nothing untrusted reaches it, and it is absent from production dependencies and the ' +
      'published overlay.',
    expires: '2026-11-03',
  },
};

// npm 11.17 exports .npmrc's allow-scripts into lifecycle environments, then
// rejects that same policy as an environment override in the nested npm audit.
// Let npm reload the original configuration instead. Leave every other setting
// (including registry/auth configuration) and the user's .npmrc untouched.
function auditEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'npm_config_allow_scripts') delete env[key];
  }
  return env;
}

function runAudit(npmPath) {
  return spawnSync(
    process.execPath,
    [npmPath, 'audit', `--audit-level=${AUDIT_LEVEL}`, '--json', ...process.argv.slice(2)],
    {
      env: auditEnvironment(),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'inherit'],
    }
  );
}

function writeLines(stream, lines) {
  if (lines.length > 0) stream.write(`${lines.join('\n')}\n`);
}

function main() {
  if (!process.env.npm_execpath) {
    console.error('Run this launcher with npm run audit:dependencies.');
    return 1;
  }
  const result = runAudit(process.env.npm_execpath);
  const today = new Date().toISOString().slice(0, 10);
  // assessAuditRun fails closed on a spawn error, signal, unparsable output,
  // or npm audit error, so none of them can turn into a green check.
  const verdict = assessAuditRun(result, ACCEPTED_ADVISORIES, today);
  writeLines(process.stdout, verdict.stdout);
  writeLines(process.stderr, verdict.stderr);
  return verdict.exitCode;
}

process.exitCode = main();
