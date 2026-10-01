import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test';
import { createTemporaryDirectory } from '../../core/__tests__/helpers/resources.ts';
import type { CodiffUpdateStatus } from '../../core/types.ts';
import { createCommandTransport } from './helpers/command-transport.ts';

const require = createRequire(import.meta.url);
type CommandTransport = ReturnType<typeof createCommandTransport>['transport'];
const { createForkUpdater } = require('../fork-updater.cjs') as {
  createForkUpdater: (options: {
    appPath: string;
    commandTransport: CommandTransport;
    confirmUpdate: () => Promise<boolean>;
    currentVersion: string;
    getEnvironment: () => Promise<Record<string, string>>;
    getModel?: () => string;
    getProcessStartTime?: (pid: number) => string | null;
    isPackaged: boolean;
    onStatusChange?: (status: CodiffUpdateStatus) => void;
    platform: string;
    updateDirectory: string;
  }) => {
    applyLatest: () => Promise<CodiffUpdateStatus>;
    applyUpdate: () => Promise<CodiffUpdateStatus>;
    dismissUpdate: () => CodiffUpdateStatus;
    getStatus: () => CodiffUpdateStatus;
  };
};

const launchOptions = (updateDirectory: string) => {
  const commands = createCommandTransport(({ process: child }) => {
    Object.assign(child, { pid: process.pid, unref: vi.fn() });
  });
  return {
    commands,
    options: {
      appPath: '/Applications/Personal Codiff.app',
      commandTransport: commands.transport,
      confirmUpdate: async () => true,
      currentVersion: '1.14.0',
      getEnvironment: async () => ({ PATH: '/test/bin' }),
      getProcessStartTime: () => 'fixture-start',
      isPackaged: true,
      platform: 'darwin',
      updateDirectory,
    },
  };
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test('offers a dismissible manual fork action without starting a task', async () => {
  await using directory = await createTemporaryDirectory('codiff-fork-update-');
  const { commands, options } = launchOptions(directory.path);
  const updater = createForkUpdater(options);
  expect(updater.getStatus()).toMatchObject({ phase: 'available', strategy: 'fork' });
  expect(commands.calls).toHaveLength(0);
  expect(updater.dismissUpdate().phase).toBe('idle');
  expect(updater.getStatus().phase).toBe('idle');
});

test('cancelling the full-access confirmation never starts Codex or creates a workspace', async () => {
  await using directory = await createTemporaryDirectory('codiff-fork-update-');
  const { commands, options } = launchOptions(directory.path);
  const confirmUpdate = vi.fn(async () => false);
  const getEnvironment = vi.fn(options.getEnvironment);
  const updater = createForkUpdater({ ...options, confirmUpdate, getEnvironment });
  expect((await updater.applyUpdate()).phase).toBe('available');
  expect(confirmUpdate).toHaveBeenCalledOnce();
  expect(getEnvironment).not.toHaveBeenCalled();
  expect(commands.calls).toHaveLength(0);
  expect(await readdir(directory.path)).toEqual([]);
});

test('concurrent update entry points share one confirmation before starting Codex', async () => {
  await using directory = await createTemporaryDirectory('codiff-fork-update-');
  const { commands, options } = launchOptions(directory.path);
  let approve!: (value: boolean) => void;
  const confirmUpdate = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        approve = resolve;
      }),
  );
  const updater = createForkUpdater({ ...options, confirmUpdate });
  const pending = updater.applyUpdate();
  expect((await updater.applyLatest()).phase).toBe('updating');
  expect(confirmUpdate).toHaveBeenCalledOnce();
  expect(commands.calls).toHaveLength(0);
  approve(true);
  expect((await pending).phase).toBe('updating');
  expect(commands.calls).toHaveLength(1);
  commands.calls[0].close(1);
});

test('launches one detached Codex task in an isolated workspace with durable output and the selected model', async () => {
  await using directory = await createTemporaryDirectory('codiff-fork-update-');
  const { commands, options } = launchOptions(directory.path);
  let model = 'gpt-6-sol';
  const updater = createForkUpdater({ ...options, getModel: () => model });
  model = 'gpt-6.1-sol';
  const pending = updater.applyUpdate();
  expect((await updater.applyUpdate()).phase).toBe('updating');
  expect((await pending).phase).toBe('updating');
  expect(commands.calls).toHaveLength(1);
  const command = commands.calls[0];
  const workspace = command.args[command.args.indexOf('--cd') + 1];
  expect(workspace).toMatch(`${directory.path}/run-`);
  expect(command.args).toContain('danger-full-access');
  expect(command.args).toContain('approval_policy="never"');
  expect(command.args).toContain('--skip-git-repo-check');
  expect(command.args[command.args.indexOf('--model') + 1]).toBe('gpt-6.1-sol');
  expect(command.options).toMatchObject({
    cwd: workspace,
    detached: true,
    env: { PATH: '/test/bin' },
  });
  expect(command.options.stdio?.[1]).toBeTypeOf('number');
  expect(command.options.stdio?.[2]).toBe(command.options.stdio?.[1]);
  const prompt = command.stdin.read().toString();
  expect(prompt).toContain('https://github.com/hoangbn/codiff.git');
  expect(prompt).toContain('feature/sync-codiff-upstream');
  expect(prompt).toContain('https://github.com/nkzw-tech/codiff.git');
  expect(prompt).toContain('Never push, force-push, publish a release');
  expect(prompt).toContain('restore and restart the backup');
  expect(prompt).toContain(options.appPath);
  expect(await readFile(join(workspace, 'task.txt'), 'utf8')).toBe(prompt);
  expect(await readFile(join(workspace, 'codex.log'), 'utf8')).toBe('');
  expect(JSON.parse(await readFile(join(directory.path, 'active.json'), 'utf8'))).toMatchObject({
    processStartedAt: 'fixture-start',
    workspace,
  });
  expect(updater.dismissUpdate().phase).toBe('updating');
  await writeFile(
    join(workspace, 'result.json'),
    JSON.stringify({ outcome: 'updated', summary: 'Installed and verified.' }),
  );
  command.close();
  expect(updater.getStatus()).toMatchObject({
    phase: 'updated',
    message: 'Installed and verified.',
  });
});

test('shows Codex progress and permits a retry only after a blocked job has exited', async () => {
  await using directory = await createTemporaryDirectory('codiff-fork-update-');
  const { commands, options } = launchOptions(directory.path);
  const updater = createForkUpdater(options);
  await updater.applyUpdate();
  const command = commands.calls[0];
  const workspace = command.options.cwd as string;
  await writeFile(
    join(workspace, 'codex.log'),
    `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Rebasing our patches.' } })}\n`,
  );
  vi.advanceTimersByTime(1000);
  expect(updater.getStatus().message).toBe('Rebasing our patches.');
  await writeFile(
    join(workspace, 'result.json'),
    JSON.stringify({
      outcome: 'blocked',
      summary: 'Signing identity is unavailable; installed app untouched.',
    }),
  );
  command.close();
  expect(updater.getStatus()).toMatchObject({
    phase: 'error',
    message: 'Signing identity is unavailable; installed app untouched.',
  });
  await updater.applyLatest();
  expect(commands.calls).toHaveLength(2);
  expect(commands.calls[1].options.cwd).not.toBe(workspace);
  commands.calls[1].close(1);
});

test.each([false, true])(
  'does not report success for an unsuccessful process, even with a result file: %s',
  async (hasResult) => {
    await using directory = await createTemporaryDirectory('codiff-fork-update-');
    const { commands, options } = launchOptions(directory.path);
    const updater = createForkUpdater(options);
    await updater.applyUpdate();
    const command = commands.calls[0];
    if (hasResult) {
      await writeFile(
        join(command.options.cwd as string, 'result.json'),
        JSON.stringify({ outcome: 'updated', summary: 'Not verified.' }),
      );
    }
    command.close(1);
    expect(updater.getStatus().phase).toBe('error');
    expect(updater.getStatus().message).toContain('code 1');
  },
);

test('an interrupted job without a valid result reports recovery uncertainty after relaunch', async () => {
  await using directory = await createTemporaryDirectory('codiff-fork-update-');
  const { commands, options } = launchOptions(directory.path);
  const workspace = join(directory.path, 'run-interrupted');
  await mkdir(workspace);
  await writeFile(
    join(directory.path, 'active.json'),
    JSON.stringify({ pid: 2147483647, processStartedAt: 'earlier-start', workspace }),
  );
  const updater = createForkUpdater(options);
  expect(updater.getStatus().phase).toBe('error');
  expect(updater.getStatus().message).toContain(join(workspace, 'codex.log'));
  expect(commands.calls).toHaveLength(0);
});

test('a detached task finishes and retains its log after the launcher exits', async () => {
  vi.useRealTimers();
  await using directory = await createTemporaryDirectory('codiff-fork-update-');
  const workerPath = join(directory.path, 'fake-codex.cjs');
  await writeFile(
    workerPath,
    `
    const { writeFileSync } = require('node:fs');
    process.stdin.resume();
    process.stdin.on('end', () => setTimeout(() => {
      const resultPath = process.argv[process.argv.indexOf('--output-last-message') + 1];
      writeFileSync(resultPath, JSON.stringify({ outcome: 'up-to-date', summary: 'Fixture finished after launcher exit.' }));
      console.log('Fixture log survived launcher exit.');
    }, 100));
  `,
  );
  const { commands, options } = launchOptions(directory.path);
  const modulePath = require.resolve('../fork-updater.cjs');
  execFileSync(
    process.execPath,
    [
      '-e',
      `
    const { createForkUpdater } = require(${JSON.stringify(modulePath)});
    const { spawn } = require('node:child_process');
    const updater = createForkUpdater({
      appPath: ${JSON.stringify(options.appPath)},
      confirmUpdate: async () => true,
      currentVersion: '1.14.0',
      isPackaged: true,
      platform: 'darwin',
      updateDirectory: ${JSON.stringify(directory.path)},
      getEnvironment: async () => process.env,
      commandTransport: {
        command: process.execPath,
        spawn: (command, args, settings) => spawn(command, [${JSON.stringify(workerPath)}, ...args], settings),
      },
    });
    updater.applyUpdate().then(status => process.exit(status.phase === 'updating' ? 0 : 1));
  `,
    ],
    { timeout: 5000 },
  );
  const updater = createForkUpdater({ ...options, getProcessStartTime: undefined });
  await vi.waitFor(() => expect(updater.getStatus().phase).toBe('updated'), { timeout: 5000 });
  expect(updater.getStatus().message).toBe('Fixture finished after launcher exit.');
  const activeRuns = await readdir(directory.path);
  const workspace = join(
    directory.path,
    activeRuns.find((name) => name.startsWith('run-'))!,
  );
  expect(await readFile(join(workspace, 'codex.log'), 'utf8')).toContain(
    'Fixture log survived launcher exit.',
  );
  expect(commands.calls).toHaveLength(0);
});

test('a successful exit without a structured result is not treated as a successful update', async () => {
  await using directory = await createTemporaryDirectory('codiff-fork-update-');
  const { commands, options } = launchOptions(directory.path);
  const updater = createForkUpdater(options);
  await updater.applyUpdate();
  commands.calls[0].close();
  expect(updater.getStatus().phase).toBe('error');
  expect(updater.getStatus().message).toContain('codex.log');
});

test('a relaunched app reconnects to a running task instead of launching another', async () => {
  await using directory = await createTemporaryDirectory('codiff-fork-update-');
  const { commands, options } = launchOptions(directory.path);
  const workspace = join(directory.path, 'run-active');
  await mkdir(workspace);
  await writeFile(join(workspace, 'codex.log'), '');
  await writeFile(
    join(directory.path, 'active.json'),
    JSON.stringify({ pid: process.pid, processStartedAt: 'fixture-start', workspace }),
  );
  const updater = createForkUpdater(options);
  expect((await updater.applyUpdate()).phase).toBe('updating');
  expect(commands.calls).toHaveLength(0);
});

test('a reused PID does not keep an interrupted saved update running', async () => {
  await using directory = await createTemporaryDirectory('codiff-fork-update-');
  const { commands, options } = launchOptions(directory.path);
  const workspace = join(directory.path, 'run-reused-pid');
  await mkdir(workspace);
  await writeFile(
    join(directory.path, 'active.json'),
    JSON.stringify({ pid: process.pid, processStartedAt: 'earlier-start', workspace }),
  );
  const updater = createForkUpdater(options);
  expect(updater.getStatus().phase).toBe('error');
  expect(updater.getStatus().message).toContain(join(workspace, 'codex.log'));
  expect((await updater.applyUpdate()).phase).toBe('updating');
  expect(commands.calls).toHaveLength(1);
  commands.calls[0].close(1);
});

test('reconnection notices a saved process ending even when its PID remains live', async () => {
  await using directory = await createTemporaryDirectory('codiff-fork-update-');
  const { commands, options } = launchOptions(directory.path);
  const workspace = join(directory.path, 'run-reconnected');
  await mkdir(workspace);
  await writeFile(
    join(directory.path, 'active.json'),
    JSON.stringify({ pid: process.pid, processStartedAt: 'fixture-start', workspace }),
  );
  const getProcessStartTime = vi.fn(() => 'fixture-start');
  const updater = createForkUpdater({ ...options, getProcessStartTime });
  expect(updater.getStatus().phase).toBe('updating');
  getProcessStartTime.mockReturnValue('different-start');
  vi.advanceTimersByTime(1000);
  expect(updater.getStatus().phase).toBe('error');
  expect(commands.calls).toHaveLength(0);
});

test('a failed process identity lookup does not permit an overlapping update', async () => {
  await using directory = await createTemporaryDirectory('codiff-fork-update-');
  const { commands, options } = launchOptions(directory.path);
  const workspace = join(directory.path, 'run-unverified');
  await mkdir(workspace);
  await writeFile(
    join(directory.path, 'active.json'),
    JSON.stringify({ pid: process.pid, processStartedAt: 'fixture-start', workspace }),
  );
  const updater = createForkUpdater({
    ...options,
    getProcessStartTime: () => {
      throw new Error('Process lookup unavailable.');
    },
  });
  expect((await updater.applyUpdate()).phase).toBe('updating');
  expect(updater.getStatus().message).toContain('Cannot verify the saved update process');
  expect(commands.calls).toHaveLength(0);
});

test.each(['linux', 'win32', 'development'])(
  'fails without spawning or installing on unsupported launches: %s',
  async (platform) => {
    await using directory = await createTemporaryDirectory('codiff-fork-update-');
    const { commands, options } = launchOptions(directory.path);
    const updater = createForkUpdater({
      ...options,
      isPackaged: platform !== 'development',
      platform: platform === 'development' ? 'darwin' : platform,
    });
    expect((await updater.applyUpdate()).phase).toBe('error');
    expect(commands.calls).toHaveLength(0);
  },
);

test('reports a CLI environment failure and lets the user retry without starting a process', async () => {
  await using directory = await createTemporaryDirectory('codiff-fork-update-');
  const { commands, options } = launchOptions(directory.path);
  const updater = createForkUpdater({
    ...options,
    getEnvironment: async () => {
      throw new Error('CLI environment unavailable.');
    },
  });
  expect(await updater.applyUpdate()).toMatchObject({
    phase: 'error',
    message: 'CLI environment unavailable.',
  });
  expect(commands.calls).toHaveLength(0);
});
