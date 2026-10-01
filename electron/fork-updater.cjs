// @ts-check

const { execFileSync } = require('node:child_process');
const {
  closeSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { basename, dirname, join } = require('node:path');
const { getCodexCommand } = require('./codex.cjs');
const { resolveAgentCommandTransport } = require('./agent-command.cjs');
const { getCommandEnvironment } = require('./login-shell-environment.cjs');

const FORK_REPOSITORY = 'https://github.com/hoangbn/codiff.git';
const FORK_BRANCH = 'feature/sync-codiff-upstream';
const RESULT_SCHEMA = {
  additionalProperties: false,
  properties: {
    outcome: { enum: ['updated', 'up-to-date', 'blocked'], type: 'string' },
    summary: { type: 'string' },
  },
  required: ['outcome', 'summary'],
  type: 'object',
};

/** @param {number} pid */
const readProcessStartTime = (pid) => {
  try {
    return (
      execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 1000,
      }).trim() || null
    );
  } catch (error) {
    if (/** @type {{ status?: number }} */ (error).status === 1) {
      return null;
    }
    throw error;
  }
};

/** @param {string} path */
const readLogTail = (path) => {
  const descriptor = openSync(path, 'r');
  try {
    const size = fstatSync(descriptor).size;
    const buffer = Buffer.alloc(Math.min(size, 32_768));
    const bytes = readSync(descriptor, buffer, 0, buffer.length, size - buffer.length);
    return buffer.subarray(0, bytes).toString('utf8');
  } finally {
    closeSync(descriptor);
  }
};

/**
 * @param {{ appPath: string; appPid: number; currentVersion: string; workspace: string }} context
 */
const updatePrompt = (
  context,
) => `Update this personal Codiff fork and reinstall the local macOS app. You own the entire procedure: Git, conflict resolution, focused verification, packaging, backup, installation, rollback and restart.

Work only in the supplied update workspace. Clone ${FORK_REPOSITORY}, branch ${FORK_BRANCH}, into a new source directory there. Do not use, reset, clean or rebase an existing development checkout. Add https://github.com/nkzw-tech/codiff.git as upstream, fetch its latest main, and rebase the fork's patches onto that exact upstream revision in this isolated clone. Preserve every fork customization, including Update Fork itself, and resolve conflicts deliberately. If preserving a patch is uncertain, stop and report blocked.

Read the clone's AGENTS.md and build instructions. Install with the frozen lockfile, run focused tests and checks for rebased changes, then build and package for the running Mac architecture using the repository's scripts. Do not weaken tests, bypass Gatekeeper, remove quarantine or disable signing to force success. Missing tools, authentication, signing or install permissions are blockers, not permission to change global configuration or use sudo.

Never push, force-push, publish a release, merge a PR, change LFV dependencies, or modify unrelated repositories. Preserve the user's preferences, models, terminal helper, review data and other personal settings. The JSON below is path/process data, not shell code.

Before replacing anything, validate the completed app bundle and retain a usable backup of the exact installed bundle. Do not replace a running app: request a normal quit so pending comments can be saved/copied, and wait for it to exit. Do not force-kill it. Your process is detached and its log survives Codiff closing. Install into exactly the supplied appPath, restart that bundle and verify the installed bundle and successful startup, not merely the shell CLI version. On installation or startup failure, restore and restart the backup; report any recovery uncertainty. Retain the backup and this workspace for inspection. Do not touch the current app if any pre-install step fails.

Report outcome updated only after installation and startup are verified. Report up-to-date only if the installed bundle already contains this fork and the fetched upstream revision; do not infer this from the semver alone. Otherwise report blocked with the concrete reason and any recovery action. Emit brief progress messages as you work, and finish with the required JSON result.

${JSON.stringify(context, null, 2)}`;

/**
 * @param {{
 *   appPath: string;
 *   confirmUpdate: () => Promise<boolean>;
 *   currentVersion: string;
 *   isPackaged: boolean;
 *   platform: string;
 *   updateDirectory: string;
 *   getModel?: () => string;
 *   getProcessStartTime?: (pid: number) => string | null;
 *   commandTransport?: import('./agent-command.cjs').AgentCommandTransport;
 *   getEnvironment?: typeof getCommandEnvironment;
 *   onStatusChange?: (status: import('../core/types.ts').CodiffUpdateStatus) => void;
 * }} options
 */
const createForkUpdater = ({
  appPath,
  commandTransport,
  confirmUpdate,
  currentVersion,
  getEnvironment = getCommandEnvironment,
  getModel,
  getProcessStartTime = readProcessStartTime,
  isPackaged,
  onStatusChange,
  platform,
  updateDirectory,
}) => {
  /** @type {import('../core/types.ts').CodiffUpdateStatus} */
  let status = { currentVersion, phase: 'available', strategy: 'fork' };
  /** @type {{ pid: number; processStartedAt: string; workspace: string } | null} */
  let active = null;
  let ownsProcess = false;
  /** @type {ReturnType<typeof setInterval> | undefined} */
  let poll;
  const activePath = join(updateDirectory, 'active.json');
  const statusPath = join(updateDirectory, 'status.json');

  try {
    const saved = JSON.parse(readFileSync(statusPath, 'utf8'));
    if (
      ['updated', 'error'].includes(saved.phase) &&
      typeof saved.message === 'string' &&
      saved.message.trim()
    ) {
      status = { ...status, message: saved.message, phase: saved.phase };
    }
  } catch {}

  /** @param {import('../core/types.ts').CodiffUpdatePhase} phase @param {string} [message] */
  const setStatus = (phase, message) => {
    status = { currentVersion, message, phase, strategy: 'fork' };
    onStatusChange?.({ ...status });
    return { ...status };
  };

  /** @param {string} [failure] @param {boolean} [verifyExit] */
  const finish = (failure, verifyExit = false) => {
    if (!active) {
      return;
    }
    const { workspace } = active;
    active = null;
    ownsProcess = false;
    clearInterval(poll);
    try {
      if (failure) {
        throw new Error(failure);
      }
      if (verifyExit) {
        const exit = JSON.parse(readFileSync(join(workspace, 'exit.json'), 'utf8'));
        if (!Number.isInteger(exit.code) || exit.code < 0 || exit.code > 255) {
          throw new Error('Codex did not record a valid exit status.');
        }
        if (exit.code !== 0) {
          throw new Error(`Codex exited with code ${exit.code}.`);
        }
      }
      const result = JSON.parse(readFileSync(join(workspace, 'result.json'), 'utf8'));
      if (
        !['updated', 'up-to-date', 'blocked'].includes(result?.outcome) ||
        typeof result.summary !== 'string' ||
        !result.summary.trim()
      ) {
        throw new Error('Codex did not return a valid update result.');
      }
      setStatus(result.outcome === 'blocked' ? 'error' : 'updated', result.summary);
    } catch (error) {
      setStatus(
        'error',
        `${error instanceof Error ? error.message : String(error)} Inspect ${join(workspace, 'codex.log')} before retrying.`,
      );
    }
    try {
      writeFileSync(statusPath, JSON.stringify(status), { mode: 0o600 });
      rmSync(activePath, { force: true });
    } catch (error) {
      setStatus(
        'error',
        `${status.message} Could not save the update status: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const monitor = () => {
    if (!active) {
      return;
    }
    if (!ownsProcess) {
      try {
        if (getProcessStartTime(active.pid) !== active.processStartedAt) {
          finish(undefined, true);
          return;
        }
      } catch {
        setStatus(
          'updating',
          `Cannot verify the saved update process. Inspect ${join(active.workspace, 'codex.log')}.`,
        );
        return;
      }
    }
    try {
      for (const line of readLogTail(join(active.workspace, 'codex.log')).split('\n').reverse()) {
        try {
          const event = JSON.parse(line);
          if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
            const message = String(event.item.text).trim().slice(0, 500);
            if (message && message !== status.message) {
              setStatus('updating', message);
            }
            break;
          }
        } catch {}
      }
    } catch {}
  };

  const startMonitoring = () => {
    poll = setInterval(monitor, 1000);
    poll.unref();
  };

  try {
    const saved = JSON.parse(readFileSync(activePath, 'utf8'));
    if (
      Number.isSafeInteger(saved.pid) &&
      saved.pid > 0 &&
      typeof saved.processStartedAt === 'string' &&
      saved.processStartedAt.trim() &&
      typeof saved.workspace === 'string' &&
      dirname(saved.workspace) === updateDirectory &&
      basename(saved.workspace).startsWith('run-')
    ) {
      active = saved;
      setStatus('updating', 'Reconnecting to the fork update…');
      monitor();
      if (active) {
        startMonitoring();
      }
    }
  } catch {}

  const applyUpdate = async () => {
    if (active || status.phase === 'updating') {
      return { ...status };
    }
    if (!isPackaged || platform !== 'darwin' || !basename(appPath).endsWith('.app')) {
      return setStatus('error', 'Update Fork requires an installed macOS Codiff.app.');
    }
    const previousStatus = { ...status };
    setStatus('updating', 'Waiting for Update Fork confirmation…');
    try {
      if (!(await confirmUpdate())) {
        status = previousStatus;
        onStatusChange?.({ ...status });
        return { ...status };
      }
      setStatus('updating', 'Starting Codex with full local access…');
      const environment = await getEnvironment();
      const transport = resolveAgentCommandTransport(commandTransport, getCodexCommand);
      const model = getModel?.();
      mkdirSync(updateDirectory, { recursive: true, mode: 0o700 });
      const workspace = mkdtempSync(join(updateDirectory, 'run-'));
      const schemaPath = join(workspace, 'schema.json');
      const prompt = updatePrompt({ appPath, appPid: process.pid, currentVersion, workspace });
      writeFileSync(schemaPath, JSON.stringify(RESULT_SCHEMA), { mode: 0o600 });
      writeFileSync(join(workspace, 'task.txt'), prompt, { mode: 0o600 });
      const logDescriptor = openSync(join(workspace, 'codex.log'), 'a', 0o600);
      let child;
      try {
        child = transport.spawn(
          '/bin/sh',
          [
            join(__dirname, 'fork-update-runner.sh'),
            join(workspace, 'exit.json'),
            transport.command,
            'exec',
            '--cd',
            workspace,
            '--skip-git-repo-check',
            '--sandbox',
            'danger-full-access',
            '-c',
            'approval_policy="never"',
            '--json',
            '--color',
            'never',
            '--output-schema',
            schemaPath,
            '--output-last-message',
            join(workspace, 'result.json'),
            ...(model ? ['--model', model] : []),
            '-',
          ],
          {
            cwd: workspace,
            detached: true,
            env: environment,
            stdio: ['pipe', logDescriptor, logDescriptor],
          },
        );
      } finally {
        closeSync(logDescriptor);
      }
      child.on('error', (error) => {
        if (!active) {
          setStatus('error', error.message);
        }
      });
      child.on('close', (code, signal) =>
        finish(
          code === 0
            ? undefined
            : `Codex exited ${signal ? `with ${signal}` : `with code ${code}`}.`,
        ),
      );
      child.stdin?.on('error', () => child.kill());
      if (!child.pid) {
        return setStatus('error', 'Codex could not start. Check the CLI installation.');
      }
      active = { pid: child.pid, processStartedAt: '', workspace };
      ownsProcess = true;
      try {
        const processStartedAt = getProcessStartTime(child.pid);
        if (!processStartedAt) {
          throw new Error('Codex exited before its process identity could be saved.');
        }
        active.processStartedAt = processStartedAt;
        writeFileSync(activePath, JSON.stringify(active), { mode: 0o600 });
      } catch (error) {
        child.kill();
        return setStatus(
          'updating',
          `Stopping Codex: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      startMonitoring();
      child.unref();
      child.stdin?.end(prompt);
      return { ...status };
    } catch (error) {
      return setStatus('error', error instanceof Error ? error.message : String(error));
    }
  };

  return {
    applyLatest: applyUpdate,
    applyUpdate,
    dismissUpdate: () => {
      if (active || status.phase === 'updating') {
        return { ...status };
      }
      try {
        rmSync(statusPath, { force: true });
        return setStatus('idle');
      } catch (error) {
        return setStatus(
          'error',
          `Could not dismiss the update status: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    getStatus: () => ({ ...status }),
  };
};

module.exports = { createForkUpdater };
