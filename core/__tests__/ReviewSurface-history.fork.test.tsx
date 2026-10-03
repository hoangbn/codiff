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
  expect(
    [...view.container.querySelectorAll('[role="tab"]')].some((tab) =>
      tab.textContent?.includes('History'),
    ),
  ).toBe(false);
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
  const source = { ref: 'a'.repeat(40), type: 'commit' } as const;
  await view.rerender(
    <ReviewSurface
      commitMetadata={{
        author: { date: '2026-05-28T00:00:00Z', email: 'grace@example.test', name: 'Grace' },
        body: 'A message on an empty commit.',
        committer: { date: '2026-05-28T00:00:00Z', email: 'grace@example.test', name: 'Grace' },
        files: [],
        parents: [],
        ref: source.ref,
        refs: [],
        shortRef: 'aaaaaaa',
        signature: { status: 'N' },
        stats: { additions: 0, binaryFiles: 0, deletions: 0, files: 0, renamedFiles: 0 },
        subject: 'Empty but intentional',
        trailers: [],
      }}
      initialMode="tree"
      snapshot={{ ...snapshot, repository: { ...snapshot.repository, source } }}
    />,
  );
  expect(view.container.textContent).toContain('Empty but intentional');
  expect(view.container.textContent).toContain('Grace');
  expect(view.container.textContent).toContain('A message on an empty commit.');
});
