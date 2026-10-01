# Update Fork

This fork's desktop app uses **Update Fork**, not upstream's release updater.
Click the sidebar button or **Codiff → Update Fork** to launch your installed
Codex CLI. Codex handles the whole update: fetch, rebase, resolve conflicts,
focused checks, build, backup, reinstall and restart. It uses the current
OpenAI model preference and existing Codex authentication. No fork release is
required.

**This action runs Codex with full local filesystem/network access and without
interactive approval prompts.** The task instructions constrain its work, but
they are not a security sandbox. Only use this with a trusted fork, upstream and
Codex configuration. Nothing runs automatically on startup or on a timer.

The source is `hoangbn/codiff`, branch `feature/sync-codiff-upstream`; upstream
is `nkzw-tech/codiff`, branch `main`. The launcher creates a fresh private
workspace for every attempt. Codex is instructed not to touch active development
checkouts, push branches, publish releases or change LFV dependencies. It must
preserve fork patches and personal settings, retain a backup, stop before
installation if checks fail, and restore the backup if installation/startup
fails. These installation decisions belong to Codex, not a second updater
implementation in the app.

The button displays running, failed and completed states; its tooltip shows
Codex's latest progress or result. Repeated clicks do not start concurrent jobs.
Every entry point, including the app menu, asks for confirmation of Codex's
unrestricted filesystem/network access and lack of interactive approvals before
starting the task. Cancelling leaves the installed app untouched.
The job is detached with its output redirected to a file, so closing Codiff
does not terminate it. A relaunched app reconnects to the saved job rather than
starting another one.
Reconnection checks the saved process start time as well as its PID so an
unrelated process reusing that PID does not leave the updater stuck running.
Completed and failed task results are retained across app relaunches. The app
menu also displays immediate launch failures when no review window is open.
Dismissal clears the saved terminal notification. A detached supervisor records
Codex's exit code; reconnection requires a successful exit as well as a valid
result before reporting success.

Task instructions, JSON event logs and the final structured result live under
`fork-updates/run-*` in Electron's user-data directory (normally
`~/Library/Application Support/Codiff` on macOS). Keep that workspace when
investigating a failed update, especially if the app was closed during install.
The latest completed task status is saved in `fork-updates/status.json`.
An interrupted process without a valid result is an error, not success.

## Requirements and limits

- This first version supports an installed macOS `.app` bundle. Development
  launches and other operating systems report an actionable error without
  launching Codex or falling back to upstream's installer.
- Install/authenticate Codex beforehand. Existing `CODIFF_CODEX_PATH` discovery
  is supported; dependencies and signing requirements come from the fork's
  build instructions. Missing credentials, tools or permissions are blockers.
- The fork branch must contain the reviewed patches to preserve, including this
  updater. Uncommitted changes or ad-hoc edits inside an installed bundle are
  not source patches; commit those customizations to the fork first.
- The automatic update notification setting does not hide this manual action.
  Dismiss it to hide the sidebar button; the app menu remains available.
- LFV's embedded Codiff dependency is separate and is not updated here.

## Verification

Focused tests exercise the public updater and UI boundaries with a fake Codex
transport. They cover isolated launch instructions, full-access disclosure,
durable logging, duplicate clicks, progress, structured failures and reconnecting
after restart. They do not fetch/rebase live source, spend Codex usage, replace
an installed app, or prove Codex's decisions. A real update needs an explicit
manual run against a disposable installed macOS app before relying on it.
