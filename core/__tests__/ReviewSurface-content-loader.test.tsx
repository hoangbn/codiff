/**
 * @vitest-environment jsdom
 */

import { act } from 'react';
import { expect, test, vi } from 'vite-plus/test';
import { ReviewSurface, type ReviewContentLoader } from '../react.ts';
import type { ChangedFile, DiffSection, SharedWalkthroughSnapshot } from '../types.ts';
import { createChangedFile } from './helpers/fixtures.ts';
import { renderReact, waitFor } from './helpers/react.tsx';

const reactActEnvironment = globalThis as typeof globalThis & {
  ResizeObserver?: typeof ResizeObserver;
};
reactActEnvironment.ResizeObserver ??= class ResizeObserver {
  disconnect() {}
  observe() {}
  unobserve() {}
};
HTMLElement.prototype.scrollBy ??= function scrollBy() {};
HTMLElement.prototype.scrollTo ??= function scrollTo() {};

const createDeferredFile = (path: string, fingerprint = `${path}:1`): ChangedFile => {
  const file = createChangedFile(path, { fingerprint });
  return {
    ...file,
    sections: file.sections.map((section) => ({
      ...section,
      loadState: 'deferred' as const,
      patch: '',
      summary: {
        canLoad: true,
        reason: 'Load the full diff to review this file.',
      },
    })),
  };
};

const createImageFile = (path: string, fingerprint = `${path}:1`): ChangedFile => {
  const file = createChangedFile(path, { fingerprint });
  return {
    ...file,
    sections: file.sections.map((section) => ({
      ...section,
      binary: true,
      loadState: 'binary' as const,
      patch: '',
      summary: { reason: 'Binary image changed.' },
    })),
  };
};

const createLoadedSection = (file: ChangedFile, marker: string): DiffSection => {
  const section = file.sections[0]!;
  const addedLines = marker.split('\n');
  return {
    ...section,
    loadState: 'ready',
    newFile: { contents: `${marker}\n`, name: file.path },
    oldFile: { contents: 'before\n', name: file.path },
    patch: `diff --git a/${file.path} b/${file.path}\n@@ -1 +1,${addedLines.length} @@\n-before\n${addedLines.map((line) => `+${line}`).join('\n')}\n`,
    summary: undefined,
  };
};

const createSnapshot = (files: ReadonlyArray<ChangedFile>): SharedWalkthroughSnapshot => {
  const source = { type: 'working-tree' } as const;
  return {
    branch: 'main',
    codiffVersion: '1.10.1',
    exportedAt: '2026-08-09T00:00:00.000Z',
    files,
    kind: 'codiff-walkthrough-share',
    preferences: {
      codeFontFamily: '',
      codeFontSize: 13,
      diffStyle: 'split',
      showWhitespace: false,
      theme: 'system',
      wordWrap: false,
    },
    repository: { root: '/repo', source },
    version: 1,
    walkthrough: {
      agent: 'codex',
      chapters: [],
      focus: 'Review the implementation.',
      generatedAt: '2026-08-09T00:00:00.000Z',
      kind: 'narrative',
      repo: { branch: 'main', root: '/repo' },
      source,
      support: [],
      title: 'Repository review',
      version: 4,
    },
  };
};

const unavailableImage = async () => ({
  reason: 'No image content.',
  status: 'unavailable' as const,
});

test('a read-only review surface loads a deferred text section', async () => {
  const file = createDeferredFile('src/large.ts');
  let resolveSection!: (section: DiffSection) => void;
  const sectionPromise = new Promise<DiffSection>((resolve) => {
    resolveSection = resolve;
  });
  const contentLoader = {
    loadImageContent: vi.fn(unavailableImage),
    loadSectionContent: vi.fn(() => sectionPromise),
  } satisfies ReviewContentLoader;
  await using view = await renderReact(
    <ReviewSurface
      contentLoader={contentLoader}
      initialMode="tree"
      snapshot={createSnapshot([file])}
    />,
  );

  const loadButton = view.container.querySelector<HTMLButtonElement>('.codiff-load-button');
  expect(loadButton?.textContent).toBe('Load');
  expect(view.container.querySelector('.codiff-file-comment-button')).toBeNull();
  expect(view.container.querySelector('[title="Open file in editor"]')).toBeNull();

  await act(async () => loadButton?.click());
  await waitFor(() => expect(loadButton?.textContent).toBe('Loading...'));
  expect(contentLoader.loadSectionContent).toHaveBeenCalledWith({
    force: true,
    kind: 'unstaged',
    path: 'src/large.ts',
    showWhitespace: false,
    source: { type: 'working-tree' },
  });

  await act(async () => resolveSection(createLoadedSection(file, 'loaded text marker')));
  await waitFor(() => {
    expect(view.container.querySelector('.codiff-load-button')).toBeNull();
    expect(
      view.container.querySelector('.codiff-file-header .codiff-line-count')?.getAttribute('title'),
    ).toBe('1 added line, 1 removed line');
  });
});

test('section and image loader failures stay contained to their content units', async () => {
  const loadedFile = createDeferredFile('src/loaded.ts');
  const failedFile = createDeferredFile('src/failed.ts');
  const goodImage = createImageFile('assets/good.png');
  const failedImage = createImageFile('assets/failed.png');
  const contentLoader = {
    loadImageContent: vi.fn(({ path }) => {
      if (path === failedImage.path) {
        throw new Error('Image transport failed.');
      }
      return Promise.resolve({
        newImage: {
          dataUrl: 'data:image/png;base64,Z29vZA==',
          mimeType: 'image/png',
          name: path,
          size: 4,
        },
        status: 'ready' as const,
      });
    }),
    loadSectionContent: vi.fn(async ({ path }) => {
      if (path === failedFile.path) {
        throw new Error('Section transport failed.');
      }
      return createLoadedSection(loadedFile, 'other content remains usable');
    }),
  } satisfies ReviewContentLoader;
  await using view = await renderReact(
    <ReviewSurface
      contentLoader={contentLoader}
      initialMode="tree"
      snapshot={createSnapshot([loadedFile, failedFile, goodImage, failedImage])}
    />,
  );

  const loadButtons = view.container.querySelectorAll<HTMLButtonElement>('.codiff-load-button');
  expect(loadButtons).toHaveLength(2);
  await act(async () => {
    loadButtons[0]?.click();
    loadButtons[1]?.click();
  });

  await waitFor(() => {
    expect(contentLoader.loadSectionContent).toHaveBeenCalledTimes(2);
    expect(contentLoader.loadImageContent).toHaveBeenCalledTimes(2);
    expect(view.container.querySelectorAll('.codiff-load-button')).toHaveLength(0);
    expect(
      [...view.container.querySelectorAll('.codiff-file-header')]
        .find((header) => header.textContent?.includes(loadedFile.path))
        ?.querySelector('.codiff-line-count')
        ?.getAttribute('title'),
    ).toBe('1 added line, 1 removed line');
    expect(
      [...view.container.querySelectorAll('.codiff-file-header')]
        .find((header) => header.textContent?.includes(failedFile.path))
        ?.querySelector('.codiff-line-count'),
    ).toBeNull();
    expect(view.container.querySelector('img[alt="New assets/good.png"]')).not.toBeNull();
    expect(view.container.textContent).toContain('Codiff could not load this image.');
  });
  expect(contentLoader.loadImageContent).toHaveBeenCalledWith({
    kind: 'unstaged',
    path: 'assets/good.png',
    source: { type: 'working-tree' },
  });
});

test('a stale section result cannot replace content from a newer snapshot', async () => {
  const firstFile = createDeferredFile('src/large.ts', 'first');
  const secondFile = createDeferredFile('src/large.ts', 'second');
  const resolvers: Array<(section: DiffSection) => void> = [];
  const contentLoader = {
    loadImageContent: vi.fn(unavailableImage),
    loadSectionContent: vi.fn(
      () =>
        new Promise<DiffSection>((resolve) => {
          resolvers.push(resolve);
        }),
    ),
  } satisfies ReviewContentLoader;
  await using view = await renderReact(
    <ReviewSurface
      contentLoader={contentLoader}
      initialMode="tree"
      snapshot={createSnapshot([firstFile])}
    />,
  );

  await act(async () =>
    view.container.querySelector<HTMLButtonElement>('.codiff-load-button')?.click(),
  );
  const nextSnapshot = createSnapshot([secondFile]);
  await view.rerender(
    <ReviewSurface contentLoader={contentLoader} initialMode="tree" snapshot={nextSnapshot} />,
  );
  await waitFor(() =>
    expect(view.container.querySelector<HTMLButtonElement>('.codiff-load-button')).not.toBeNull(),
  );
  await act(async () =>
    view.container.querySelector<HTMLButtonElement>('.codiff-load-button')?.click(),
  );
  expect(resolvers).toHaveLength(2);

  await act(async () =>
    resolvers[1]?.(createLoadedSection(secondFile, 'new snapshot marker\nsecond line')),
  );
  await waitFor(() =>
    expect(
      view.container.querySelector('.codiff-file-header .codiff-line-count')?.getAttribute('title'),
    ).toBe('2 added lines, 1 removed line'),
  );
  await act(async () => resolvers[0]?.(createLoadedSection(firstFile, 'stale snapshot marker')));
  expect(
    view.container.querySelector('.codiff-file-header .codiff-line-count')?.getAttribute('title'),
  ).toBe('2 added lines, 1 removed line');
});

test('a stale image result cannot replace a newer image preview', async () => {
  const firstFile = createImageFile('assets/preview.png', 'first');
  const secondFile = createImageFile('assets/preview.png', 'second');
  let resolveFirst!: (result: Awaited<ReturnType<ReviewContentLoader['loadImageContent']>>) => void;
  let imageRequestCount = 0;
  const contentLoader = {
    loadImageContent: vi.fn(() => {
      imageRequestCount += 1;
      if (imageRequestCount === 1) {
        return new Promise<Awaited<ReturnType<ReviewContentLoader['loadImageContent']>>>(
          (resolve) => {
            resolveFirst = resolve;
          },
        );
      }
      return Promise.resolve({
        newImage: {
          dataUrl: 'data:image/png;base64,bmV3',
          mimeType: 'image/png',
          name: secondFile.path,
          size: 3,
        },
        status: 'ready' as const,
      });
    }),
    loadSectionContent: vi.fn(async () => {
      throw new Error('Unexpected section request.');
    }),
  } satisfies ReviewContentLoader;
  await using view = await renderReact(
    <ReviewSurface
      contentLoader={contentLoader}
      initialMode="tree"
      snapshot={createSnapshot([firstFile])}
    />,
  );
  await waitFor(() => expect(contentLoader.loadImageContent).toHaveBeenCalledOnce());

  await view.rerender(
    <ReviewSurface
      contentLoader={contentLoader}
      initialMode="tree"
      snapshot={createSnapshot([secondFile])}
    />,
  );
  await waitFor(() =>
    expect(
      view.container.querySelector<HTMLImageElement>('img[alt="New assets/preview.png"]')?.src,
    ).toBe('data:image/png;base64,bmV3'),
  );

  await act(async () =>
    resolveFirst({
      newImage: {
        dataUrl: 'data:image/png;base64,b2xk',
        mimeType: 'image/png',
        name: firstFile.path,
        size: 3,
      },
      status: 'ready',
    }),
  );
  expect(
    view.container.querySelector<HTMLImageElement>('img[alt="New assets/preview.png"]')?.src,
  ).toBe('data:image/png;base64,bmV3');
});

test('consumers without a content loader keep deferred content read-only', async () => {
  const file = createDeferredFile('src/large.ts');
  await using view = await renderReact(
    <ReviewSurface initialMode="tree" snapshot={createSnapshot([file])} />,
  );

  expect(view.container.querySelector('.codiff-load-button')).toBeNull();
  expect(view.container.querySelector('.codiff-file-header .codiff-line-count')).toBeNull();
  expect(view.container.textContent).toContain(file.path);
  expect(view.container.querySelector('.codiff-file-comment-button')).toBeNull();
});
