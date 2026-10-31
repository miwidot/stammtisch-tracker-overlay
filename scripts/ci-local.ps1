# Runs every step of .github/workflows/ci.yml locally, for when hosted runners
# are unavailable. It builds the commit CI would test (a --no-ff merge of the PR
# branch onto the base, so HEAD^1 = base and HEAD^2 = PR head), runs the
# "Validate & Build" job in a temporary worktree, then repeats the
# "Windows validation (LF checkout)" job in a fresh clone checked out with
# core.autocrlf=true. Your working tree is not touched.
#
#   pwsh scripts/ci-local.ps1 -Branch feat/x          # origin/feat/x onto origin/main (PR run)
#   pwsh scripts/ci-local.ps1 -Branch feat/x -Local   # unpushed local branch feat/x
#   pwsh scripts/ci-local.ps1                         # origin/main alone (push-to-main run)
#
# Exits 1 if any step fails. The full log is written to $env:TEMP\tdo-ci\<branch>.log.
# The Validate & Build job runs on ubuntu-latest in CI; here it runs on the host OS.
param(
  [string] $Branch,
  [string] $Base = 'main',
  [switch] $Local,
  [string] $Repo = (git -C $PSScriptRoot rev-parse --show-toplevel)
)
$ErrorActionPreference = 'Stop'
$name = if ($Branch) { $Branch -replace '[^\w-]', '_' } else { $Base -replace '[^\w-]', '_' }
$root = Join-Path $env:TEMP "tdo-ci\$name"
$log = "$root.log"
$results = [System.Collections.Generic.List[object]]::new()

function Step([string] $job, [string] $label, [scriptblock] $body) {
  Write-Host "[$job] $label" -ForegroundColor Cyan
  $started = Get-Date
  $global:LASTEXITCODE = 0
  try {
    & $body *>> $log
    $code = $global:LASTEXITCODE
  } catch {
    $_ | Out-File -Append $log
    $code = 1
  }
  $results.Add([pscustomobject]@{ Job = $job; Step = $label; Exit = $code; Seconds = [int]((Get-Date) - $started).TotalSeconds })
  if ($code -ne 0) { Write-Host "   FAILED (exit $code)" -ForegroundColor Red }
}

New-Item -ItemType Directory -Force (Split-Path $root) | Out-Null
git -C $Repo worktree remove --force $root 2>$null
Remove-Item -Recurse -Force $root, "$root-win" -ErrorAction SilentlyContinue
Remove-Item -Force $log -ErrorAction SilentlyContinue
git -C $Repo fetch -q origin
if ($LASTEXITCODE) { throw 'git fetch origin failed' }
git -C $Repo worktree prune

# ---- Commit under test --------------------------------------------------------
git -C $Repo worktree add -q --detach $root "origin/$Base"
if ($LASTEXITCODE) { throw "Could not check out origin/$Base" }
$mergeSha = $null
Push-Location $root
try {
  if ($Branch) {
    $head = if ($Local) { "refs/heads/$Branch" } else { "origin/$Branch" }
    git -c user.name=ci-local -c user.email=ci-local@localhost merge -q --no-ff --no-edit $head
    if ($LASTEXITCODE) { throw "$head does not merge cleanly into origin/$Base" }
    $baseSha = (git rev-parse HEAD^1).Trim()
    "testing $((git rev-parse HEAD).Trim()) = origin/$Base ($baseSha) + $head ($((git rev-parse HEAD^2).Trim()))" | Tee-Object -Append $log
  } else {
    # A push to main compares against the previous main commit.
    $baseSha = (git rev-parse HEAD^1).Trim()
    "testing origin/$Base $((git rev-parse HEAD).Trim()) against its parent $baseSha" | Tee-Object -Append $log
  }
  $mergeSha = (git rev-parse HEAD).Trim()

  $job = 'Validate & Build'
  Step $job 'npm ci' { npm ci --no-audit --no-fund }
  Step $job 'Reject changes to the generated overlay' { git diff --quiet $baseSha HEAD -- dist/ }
  Step $job 'Audit dependencies' { npm run audit:dependencies }
  Step $job 'Check dead code' { npm run fallow:check -- --fail-on-issues }
  Step $job 'Audit maintenance regressions' {
    # CI writes the report to $RUNNER_TEMP, outside the checkout, so format:check never sees it.
    $report = Join-Path $env:TEMP "tdo-ci-fallow-audit-$PID.json"
    npm run fallow:audit -- --base $baseSha --gate new-only --format json --output-file $report
    $status = $LASTEXITCODE
    npm run maintenance:ci -- report $baseSha $report
    if ($LASTEXITCODE) { $status = $LASTEXITCODE }
    Remove-Item -Force $report -ErrorAction SilentlyContinue
    $global:LASTEXITCODE = $status
  }
  Step $job 'Run Fallow security analysis' { npm run fallow:security -- --gate new --changed-since $baseSha }
  Step $job 'Lint Markdown' { npm run lint:markdown }
  Step $job 'Check formatting' { npm run format:check }
  Step $job 'Typecheck' { npm run typecheck }
  Step $job 'Check shared data JavaScript' { node --check src/lib/tarkov-api-shared.cjs }
  Step $job 'Validate source files' { npm run validate }
  Step $job 'Build overlay' { npm run build }
  Step $job 'Run tests' { npm test }
  Step $job 'Check overlay for data now supplied by tarkov.dev' { npm run check-overrides -- --strict --fail-on-stale }
} finally {
  Pop-Location
}

# ---- Windows validation (LF checkout) -------------------------------------------
git clone -q -c core.autocrlf=true --no-checkout $root "$root-win"
Push-Location "$root-win"
try {
  git checkout -q --detach $mergeSha
  $job = 'Windows validation (LF checkout)'
  Step $job 'npm ci' { npm ci --no-audit --no-fund }
  Step $job 'Verify LF checkout policy' { node -e "const text = require('node:fs').readFileSync('docs/MASTER_SAMPLES.md', 'utf8'); if (!text.includes('\n') || text.includes('\r')) throw new Error('Expected an LF checkout despite core.autocrlf=true')" }
  Step $job 'Check formatting on Windows' { npm run format:check }
  Step $job 'Audit dependencies' { npm run audit:dependencies }
  Step $job 'Typecheck' { npm run typecheck }
  Step $job 'Validate overlay' { npm run validate }
  Step $job 'Build overlay' { npm run build }
  Step $job 'Test' { npm test }
} finally {
  Pop-Location
}

$results | Format-Table -AutoSize | Out-String -Width 200 | Tee-Object -Append $log
$failed = @($results | Where-Object Exit -ne 0)
"RESULT $(if ($Branch) { $Branch } else { $Base }) @ $mergeSha : $($results.Count - $failed.Count)/$($results.Count) steps passed; log $log"
git -C $Repo worktree remove --force $root
Remove-Item -Recurse -Force "$root-win" -ErrorAction SilentlyContinue
if ($failed.Count) { exit 1 }
