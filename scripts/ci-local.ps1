# Runs the validation steps of .github/workflows/ci.yml locally, for when hosted
# runners are unavailable. It builds the commit CI would test (a --no-ff merge of
# the PR branch onto the base, so HEAD^1 = base and HEAD^2 = PR head), runs the
# "Validate & Build" job in a temporary worktree, then repeats the
# "Windows validation (LF checkout)" job in a fresh clone checked out with
# core.autocrlf=true. Your working tree is not touched.
#
#   pwsh scripts/ci-local.ps1 -Branch feat/x          # origin/feat/x onto origin/main (PR run)
#   pwsh scripts/ci-local.ps1 -Branch feat/x -Local   # committed local branch feat/x
#   pwsh scripts/ci-local.ps1                         # origin/main alone (push-to-main run)
#
# PR mode runs the PR-only guard against changes to dist/. Push mode skips it and
# builds with the next overlay tag as OVERLAY_VERSION, like CI's release build; it
# does not upload the artifact.
#
# Exits 1 if any step fails. The full log is written to <temp>/tdo-ci/<name>-<pid>.log,
# where <name> is the branch with characters other than letters, digits, "_" and "-"
# replaced by "_" (the path
# is printed at the end). Validate & Build runs on ubuntu-latest in CI and on the
# host OS here. The Windows job is only Windows evidence on a Windows host.
param(
  [string] $Branch,
  [string] $Base = 'main',
  [switch] $Local,
  [string] $Repo = (git -C $PSScriptRoot rev-parse --show-toplevel)
)
$ErrorActionPreference = 'Stop'
$temp = [System.IO.Path]::GetTempPath()
$name = if ($Branch) { $Branch -replace '[^\w-]', '_' } else { $Base -replace '[^\w-]', '_' }
# Per-run work directories and log, so concurrent runs never touch each other's files.
$root = Join-Path $temp "tdo-ci/$name-$PID"
$log = "$root.log"
$results = [System.Collections.Generic.List[object]]::new()
# CI builds without OVERLAY_VERSION except in the push-mode release build; keep a
# value from the caller's session out of every other build and restore it at exit.
$savedOverlayVersion = $env:OVERLAY_VERSION
Remove-Item Env:OVERLAY_VERSION -ErrorAction SilentlyContinue

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

function Invoke-Git([string] $what) {
  git @args
  if ($LASTEXITCODE) { throw "$what failed (git exit $LASTEXITCODE)" }
}

New-Item -ItemType Directory -Force (Split-Path $root) | Out-Null
# Reclaim checkouts left by runs that were killed before their cleanup ran.
Get-ChildItem (Split-Path $root) -Directory | Where-Object Name -Match '-(\d+)(-win)?$' | Where-Object {
  -not (Get-Process -Id ([int]$Matches[1]) -ErrorAction SilentlyContinue)
} | ForEach-Object {
  git -C $Repo worktree remove --force $_.FullName 2>$null
  Remove-Item -Recurse -Force $_.FullName -ErrorAction SilentlyContinue
}
Invoke-Git 'git fetch origin' -C $Repo fetch -q --tags origin
git -C $Repo worktree prune

# ---- Commit under test --------------------------------------------------------
Invoke-Git "checkout of origin/$Base" -C $Repo worktree add -q --detach $root "origin/$Base"
$mergeSha = $null
try {
  Push-Location $root
  try {
    if ($Branch) {
      $head = if ($Local) { "refs/heads/$Branch" } else { "origin/$Branch" }
      Invoke-Git "merging $head into origin/$Base" -c user.name=ci-local -c user.email=ci-local@localhost merge -q --no-ff --no-edit $head
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
    if ($Branch) {
      Step $job 'Reject changes to the generated overlay' { git diff --quiet $baseSha HEAD -- dist/ }
    }
    Step $job 'Audit dependencies' { npm run audit:dependencies }
    Step $job 'Check dead code' { npm run fallow:check -- --fail-on-issues }
    Step $job 'Audit maintenance regressions' {
      # CI writes the report to $RUNNER_TEMP, outside the checkout, so format:check never sees it.
      $report = Join-Path $temp "tdo-ci-fallow-audit-$PID.json"
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
    if ($Branch) {
      Step $job 'Build overlay' { npm run build }
    } else {
      Step $job 'Build overlay for release' {
        $tag = (npm run --silent next-overlay-tag).Trim()
        if ($tag -notmatch '^v\d+\.\d+$') { throw "Unexpected next overlay tag: '$tag'" }
        "release build as $tag"
        $env:OVERLAY_VERSION = $tag.Substring(1)
        try { npm run build } finally { Remove-Item Env:OVERLAY_VERSION }
      }
    }
    Step $job 'Run tests' { npm test }
    Step $job 'Check overlay for data now supplied by tarkov.dev' { npm run check-overrides -- --strict --fail-on-stale }
  } finally {
    Pop-Location
  }

  # ---- Windows validation (LF checkout) -----------------------------------------
  $job = if ($IsWindows) { 'Windows validation (LF checkout)' } else { 'LF checkout (approximation: not a Windows host)' }
  Invoke-Git 'clone for the Windows job' clone -q -c core.autocrlf=true --no-checkout $root "$root-win"
  Push-Location "$root-win"
  try {
    Invoke-Git "checkout of $mergeSha" checkout -q --detach $mergeSha
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
} finally {
  git -C $Repo worktree remove --force $root 2>$null
  Remove-Item -Recurse -Force $root, "$root-win" -ErrorAction SilentlyContinue
  git -C $Repo worktree prune
  if ($null -ne $savedOverlayVersion) { $env:OVERLAY_VERSION = $savedOverlayVersion }
}

$results | Format-Table -AutoSize | Out-String -Width 200 | Tee-Object -Append $log
$failed = @($results | Where-Object Exit -ne 0)
"RESULT $(if ($Branch) { $Branch } else { $Base }) @ $mergeSha : $($results.Count - $failed.Count)/$($results.Count) steps passed; log $log"
if ($failed.Count) { exit 1 }
