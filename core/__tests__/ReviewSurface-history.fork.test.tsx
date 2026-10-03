/** @vitest-environment jsdom */
import { act } from 'react';
import { expect, test, vi } from 'vite-plus/test';
import type { ReviewSource } from '../index.ts';
import { ReviewSurface } from '../react.ts';
import { createChangedFile } from './helpers/fixtures.ts';
import { renderReact } from './helpers/react.tsx';
import { createReviewSnapshot } from './helpers/review-snapshot.ts';

const environment = globalThis as typeof globalThis & { ResizeObserver?: typeof ResizeObserver };
environment.ResizeObserver ??= class ResizeObserver {
  disconnect() {}
  observe() {}
  unobserve() {}
};
HTMLElement.prototype.scrollTo ??= function () {};

test('History is opt-in and navigates empty comparisons', async () => {
  const snapshot = createReviewSnapshot([]);
  const onSelectSource = vi.fn<(source: ReviewSource) => void>();
  await using view = await renderReact(<ReviewSurface initialMode="tree" snapshot={snapshot} />);
  expect(
    [...view.container.querySelectorAll('[role="tab"]')].some((tab) =>
      tab.textContent?.includes('History'),
    ),
  ).toBe(false);
  expect(view.container.textContent).toContain('No matching files');
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

test('History marks a resolved starting row and does not apply the hidden Tree filter', async () => {
  const startingSource = { ref: 'main', type: 'commit' } as const;
  const snapshot = createReviewSnapshot([createChangedFile('report.md')]);
  await using view = await renderReact(
    <ReviewSurface
      history={{
        entries: [
          {
            author: 'Ada',
            committedAt: 1_780_000_000_000,
            parents: [],
            ref: 'main',
            subject: 'Starting change',
          },
        ],
        hasMore: false,
        loading: false,
        onLoadMore: () => {},
        onSelectSource: () => {},
        source: { type: 'working-tree' },
        startingSelected: true,
        startingSource,
      }}
      initialMode="tree"
      snapshot={{
        ...snapshot,
        repository: { ...snapshot.repository, source: { ref: 'a'.repeat(40), type: 'commit' } },
      }}
    />,
  );
  const input = view.container.querySelector<HTMLInputElement>(
    '[aria-label="Filter changed files"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      'missing',
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(view.container.textContent).toContain('No matching files');
  await act(async () =>
    [...view.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .find((tab) => tab.textContent?.includes('History'))!
      .click(),
  );
  expect(
    view.container.querySelector('[title="Starting change"]')?.classList.contains('selected'),
  ).toBe(true);
  expect(view.container.textContent).toContain('report.md');
  expect(view.container.textContent).not.toContain('No matching files');
});
