# CI runners

`.github/workflows/ci.yml` and `.github/workflows/release.yml` run on
GitHub-hosted runners by default. Two repository variables switch them to
self-hosted runner labels:

| Variable            | Jobs                              | Hosted default   | Self-hosted label |
| ------------------- | --------------------------------- | ---------------- | ----------------- |
| `CI_WINDOWS_RUNNER` | Windows validation (LF checkout)  | `windows-latest` | `overlay-windows` |
| `CI_LINUX_RUNNER`   | Validate & Build, Release overlay | `ubuntu-latest`  | `overlay-linux`   |

Pull requests from forks and Dependabot always use hosted runners, so their code
does not run on the owner's machine while it is under review. Once such a PR is
merged, its code (including new dependency install scripts and action versions)
runs on the self-hosted runners in the `main` CI and release runs; review
dependency and action bumps with that in mind. Use
`pwsh scripts/ci-local.ps1 -Branch <branch>` for fork and Dependabot PRs while
hosted runners are unavailable (see `docs/CONTRIBUTING.md`).

Switch to the self-hosted runners:

```powershell
gh variable set CI_WINDOWS_RUNNER --body overlay-windows
gh variable set CI_LINUX_RUNNER --body overlay-linux
```

Switch back to hosted runners:

```powershell
gh variable delete CI_WINDOWS_RUNNER
gh variable delete CI_LINUX_RUNNER
```

A job whose label has no online runner waits in the queue; it does not fall
back to a hosted runner.

The Windows job sets `core.autocrlf=true` through `GIT_CONFIG_*` job
environment variables instead of `git config --global`, so it does not change a
self-hosted machine's git configuration.

Pull requests cancel their previous CI run when a new commit is pushed. Pushes
to `main` are never cancelled, because each successful run feeds the release
workflow.

## Owner machine setup

- Windows runner: `%USERPROFILE%\actions-runner\overlay-windows`. It runs jobs
  as the signed-in Windows user, so workflow code can read that user's files
  and credentials. The RequestExtract and RemoteSession Windows runners run as
  the same user, so the three repositories are not isolated from each other on
  Windows.
- Linux runner: WSL `Ubuntu-24.04`, `~ghrunner/actions-runner/overlay-linux`.
  It runs as the dedicated account `ghrunner`, which has no sudo, no `docker`
  group, and no `gh` login, and cannot read the owner's WSL home. The release
  job needs only the `gh` binary; every `gh` call gets `GH_TOKEN` from the job.
  Do not configure a git `credential.helper` for `ghrunner`: the release push
  passes its token in the URL, and a helper would store it.
- `%USERPROFILE%\actions-runner\start-actions-runners.ps1` starts every
  configured runner that is not running (WSL runners via `wsl -u ghrunner`). The
  logon task "RequestExtract Actions Runners" runs it.

Run only this private repository's own workflows on these runners.

To remove a runner, get a removal token and unregister it from its directory:

```powershell
$t = gh api -X POST repos/tarkovtracker-org/tarkov-data-overlay/actions/runners/remove-token --jq .token
.\config.cmd remove --token $t                 # Windows runner directory
# WSL (as ghrunner): ./config.sh remove --token <token>
```
