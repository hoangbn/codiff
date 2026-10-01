import { createRequire } from 'node:module';
import { expect, test, vi } from 'vite-plus/test';
import type { CodiffUpdateStatus } from '../../core/types.ts';

const require = createRequire(import.meta.url);
const { showForkUpdateFailure, updateForkFromMenu } = require('../main/fork-update.cjs') as {
  showForkUpdateFailure: (
    message: string,
    dialog: { showMessageBox: (options: { message: string; type: string }) => Promise<unknown> },
  ) => Promise<unknown>;
  updateForkFromMenu: (
    updater: { applyUpdate: () => Promise<CodiffUpdateStatus> } | null,
    dialog: { showMessageBox: (options: { message: string; type: string }) => Promise<unknown> },
  ) => Promise<void>;
};

test('an asynchronous update failure and the menu share one pending native dialog', async () => {
  let dismiss!: () => void;
  const dialog = {
    showMessageBox: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          dismiss = resolve;
        }),
    ),
  };
  const notification = showForkUpdateFailure('Codex exited with code 127.', dialog);
  const menu = updateForkFromMenu(
    {
      applyUpdate: async () => ({
        currentVersion: '1.14.0',
        message: 'Codex exited with code 127.',
        phase: 'error',
      }),
    },
    dialog,
  );
  await Promise.resolve();
  expect(dialog.showMessageBox).toHaveBeenCalledOnce();
  dismiss();
  await Promise.all([notification, menu]);
  const nextNotification = showForkUpdateFailure('Another failed attempt.', dialog);
  expect(dialog.showMessageBox).toHaveBeenCalledTimes(2);
  dismiss();
  await nextNotification;
});

test('reports a returned update failure even without a renderer window', async () => {
  const dialog = { showMessageBox: vi.fn(async () => {}) };
  await updateForkFromMenu(
    {
      applyUpdate: async () => ({
        currentVersion: '1.14.0',
        message: 'Codex CLI was not found.',
        phase: 'error',
      }),
    },
    dialog,
  );
  expect(dialog.showMessageBox).toHaveBeenCalledWith({
    message: 'Updating the fork failed: Codex CLI was not found.',
    type: 'error',
  });
});

test.each(['available', 'idle', 'updating', 'updated'] as const)(
  'does not show an error for an update in phase %s',
  async (phase) => {
    const dialog = { showMessageBox: vi.fn(async () => {}) };
    await updateForkFromMenu(
      { applyUpdate: async () => ({ currentVersion: '1.14.0', phase }) },
      dialog,
    );
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  },
);

test('reports an unexpected menu launch failure', async () => {
  const dialog = { showMessageBox: vi.fn(async () => {}) };
  await updateForkFromMenu(
    {
      applyUpdate: async () => {
        throw new Error('Confirmation unavailable.');
      },
    },
    dialog,
  );
  expect(dialog.showMessageBox).toHaveBeenCalledWith({
    message: 'Updating the fork failed: Confirmation unavailable.',
    type: 'error',
  });
});
