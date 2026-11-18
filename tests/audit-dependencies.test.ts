import { afterEach, describe, expect, it } from './test-support.js';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const temporaryDirs: string[] = [];
const launcher = resolve('scripts/audit-dependencies.cjs');
const cleanReport = JSON.stringify({ auditReportVersion: 2, vulnerabilities: {} });
const unacceptedReport = JSON.stringify({
  auditReportVersion: 2,
  vulnerabilities: {
    'example-package': {
      name: 'example-package',
      severity: 'high',
      via: [
        {
          source: 1,
          name: 'example-package',
          title: 'Example high advisory',
          url: 'https://github.com/advisories/GHSA-xxxx-xxxx-xxxx',
          severity: 'high',
          range: '<2.0.0',
        },
      ],
      fixAvailable: false,
    },
  },
});

afterEach(() => {
  for (const directory of temporaryDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'overlay-audit-'));
  temporaryDirs.push(directory);
  return directory;
}

// Windows worker environments can enumerate npm's keys in uppercase. Node
// chooses the first case-insensitive duplicate when spawning on Windows.
function launcherEnvironment(overrides: Record<string, string> = {}) {
  const replaced = new Set([
    'npm_execpath',
    ...Object.keys(overrides).map((key) => key.toLowerCase()),
  ]);
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !replaced.has(key.toLowerCase()))
    ),
    ...overrides,
  };
}

function runLauncher({ stdout = cleanReport, exitCode = 0 } = {}) {
  const directory = temporaryDirectory();
  const npmPath = join(directory, 'npm cli.cjs');
  const invocationPath = join(directory, 'invocation.json');
  // Exercise the real launcher in a subprocess. The stand-in records the
  // invocation contract and prints a canned report; real dependency auditing
  // is checked separately with npm run audit:dependencies.
  writeFileSync(
    npmPath,
    `require('node:fs').writeFileSync(${JSON.stringify(invocationPath)}, JSON.stringify({
      args: process.argv.slice(2),
      inheritedPolicy: Object.keys(process.env).filter(
        key => key.toLowerCase() === 'npm_config_allow_scripts'
      ),
      registry: process.env.npm_config_registry,
      userconfig: process.env.npm_config_userconfig,
      ignoreScripts: process.env.npm_config_ignore_scripts
    }));
    process.stdout.write(${JSON.stringify(stdout)});
    process.exitCode = ${exitCode};`
  );
  const result = spawnSync(process.execPath, [launcher, '--loglevel=warn'], {
    encoding: 'utf8',
    env: launcherEnvironment({
      npm_execpath: npmPath,
      npm_config_allow_scripts: '@stripe/cli',
      NPM_CONFIG_ALLOW_SCRIPTS: 'another-package',
      npm_config_registry: 'https://registry.npmjs.org/',
      npm_config_userconfig: join(directory, 'user npmrc'),
      npm_config_ignore_scripts: 'true',
    }),
  });
  return { result, invocationPath };
}

describe('dependency audit launcher', () => {
  it('removes only the inherited allow-scripts policy and requests a JSON audit of all dependencies', () => {
    const { result, invocationPath } = runLauncher();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('No unaccepted advisories at or above high.');
    expect(JSON.parse(readFileSync(invocationPath, 'utf8'))).toEqual({
      args: ['audit', '--audit-level=high', '--json', '--loglevel=warn'],
      inheritedPolicy: [],
      registry: 'https://registry.npmjs.org/',
      userconfig: expect.stringContaining('user npmrc'),
      ignoreScripts: 'true',
    });
  });

  it('fails on an unaccepted high advisory reported with npm status 1', () => {
    const { result } = runLauncher({ stdout: unacceptedReport, exitCode: 1 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('GHSA-xxxx-xxxx-xxxx');
  });

  it.each([
    ['unparsable output', 'not json', 0],
    ['an npm audit error', JSON.stringify({ error: { summary: 'registry down' } }), 1],
    ['status 1 without vulnerabilities', cleanReport, 1],
    ['an unexpected npm status', cleanReport, 2],
  ])('fails closed on %s', (_label, stdout, exitCode) => {
    expect(runLauncher({ stdout, exitCode }).result.status).toBe(1);
  });

  it('fails closed when not launched by npm', () => {
    const env = launcherEnvironment();
    const result = spawnSync(process.execPath, [launcher], { encoding: 'utf8', env });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('npm run audit:dependencies');
  });

  it('fails closed when the npm entry point cannot run', () => {
    const result = spawnSync(process.execPath, [launcher], {
      encoding: 'utf8',
      env: launcherEnvironment({ npm_execpath: join(temporaryDirectory(), 'missing.cjs') }),
    });
    expect(result.status).toBe(1);
  });

  it('fails closed when npm is terminated by a signal', () => {
    const directory = temporaryDirectory();
    const npmPath = join(directory, 'npm cli.cjs');
    writeFileSync(npmPath, `process.kill(process.pid, 'SIGTERM');`);
    const result = spawnSync(process.execPath, [launcher], {
      encoding: 'utf8',
      env: launcherEnvironment({ npm_execpath: npmPath }),
    });
    expect(result.status).toBe(1);
    // Windows reports self-termination as an exit code rather than a signal.
    // Both must fail closed; the policy's signal branch is unit-tested separately.
    expect(result.stderr).toContain(
      process.platform === 'win32' ? 'did not produce a JSON report' : 'SIGTERM'
    );
  });
});
