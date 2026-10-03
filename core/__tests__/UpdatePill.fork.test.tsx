// @vitest-environment jsdom

import { act } from 'react';
import { expect, test } from 'vite-plus/test';
import { UpdatePill } from '../app/components/Panels.tsx';
import { type UpdateStatus } from '../app/components/Panels.tsx';
import { renderReact } from './helpers/react.tsx';

const noop = () => {};

const status = (partial: Partial<UpdateStatus>): UpdateStatus => ({
  currentVersion: '1.9.2',
  phase: 'idle',
  ...partial,
});

const pill = (view: { container: HTMLElement }) =>
  view.container.querySelector<HTMLButtonElement>('.update-pill');

test('labels the manual fork action and discloses full local access before launching', async () => {
  const onApply = () => {
    applied = true;
  };
  let applied = false;
  await using view = await renderReact(
    <UpdatePill onApply={onApply} status={status({ phase: 'available', strategy: 'fork' })} />,
  );
  expect(pill(view)?.textContent).toBe('Update Fork');
  expect(pill(view)?.title).toContain('full local access');
  await act(async () => pill(view)?.click());
  expect(applied).toBe(true);
});

test('shows fork progress without allowing another update', async () => {
  await using view = await renderReact(
    <UpdatePill
      onApply={noop}
      status={status({
        message: 'Building the rebased fork.',
        phase: 'updating',
        strategy: 'fork',
      })}
    />,
  );
  expect(pill(view)?.textContent).toBe('Updating Fork…');
  expect(pill(view)?.disabled).toBe(true);
  expect(pill(view)?.title).toBe('Building the rebased fork.');
});

test('shows a completed fork result rather than asking the user to install again', async () => {
  await using view = await renderReact(
    <UpdatePill
      onApply={noop}
      onDismiss={noop}
      status={status({ message: 'Installed and verified.', phase: 'updated', strategy: 'fork' })}
    />,
  );
  expect(pill(view)?.textContent).toBe('Fork Updated');
  expect(pill(view)?.disabled).toBe(true);
  expect(pill(view)?.title).toBe('Installed and verified.');
  expect(view.container.querySelector('[aria-label="Dismiss update"]')).not.toBeNull();
});
