/** @vitest-environment jsdom */
import { act } from 'react';
import { expect, test, vi } from 'vite-plus/test';
import type { ReviewSource } from '../index.ts';
import { ReviewSurface } from '../react.ts';
import { renderReact } from './helpers/react.tsx';
import { createReviewSnapshot } from './helpers/review-snapshot.ts';

const environment = globalThis as typeof globalThis & { ResizeObserver?: typeof ResizeObserver };
environment.ResizeObserver ??= class ResizeObserver {
  disconnect() {}
  observe() {}
  unobserve() {}
};
HTMLElement.prototype.scrollTo ??= function () {};

test('History is opt-in and navigates without mutation capabilities', async () => {
  const snapshot = createReviewSnapshot([]);
  const onSelectSource = vi.fn<(source: ReviewSource) => void>();
  await using view = await renderReact(<ReviewSurface initialMode="tree" snapshot={snapshot} />);
  expect(view.container.querySelector('[role="tab"][title="History"]')).toBeNull();
  await view.rerender(
    <ReviewSurface
      history={{
        entries: [
          {
            author: 'Ada',
            committedAt: 1_780_000_000_000,
            parents: [],
            ref: 'a'.repeat(40),
            subject: 'First change',
          },
        ],
        hasMore: false,
        loading: false,
        onLoadMore: () => {},
        onSelectSource,
        source: { type: 'working-tree' },
        startingSource: { type: 'working-tree' },
      }}
      initialMode="history"
      snapshot={snapshot}
    />,
  );
  const historyTab = [...view.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (button) => button.textContent?.includes('History'),
  );
  expect(historyTab).toBeDefined();
  await act(async () => historyTab?.click());
  expect(view.container.textContent).toContain('No local changes');
  expect(view.container.textContent).toContain('Ada');
  await act(async () =>
    view.container.querySelector<HTMLButtonElement>('[title="First change"]')?.click(),
  );
  expect(onSelectSource).toHaveBeenCalledWith({ ref: 'a'.repeat(40), type: 'commit' });
  expect(view.container.querySelector('.codiff-file-comment-button')).toBeNull();
});
