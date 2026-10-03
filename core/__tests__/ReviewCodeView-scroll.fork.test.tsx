/**
 * @vitest-environment jsdom
 */

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, expect, test, vi } from 'vite-plus/test';
import type { ChangedFile, ReviewSource } from '../types.ts';
import {
  markdownEditorMock,
  resetMarkdownEditorMock,
  createLoadedMarkdownFile,
} from './helpers/markdown-editor.tsx';
import { waitFor } from './helpers/react.tsx';
import {
  codeViewMock,
  resetCodeViewMock,
  ReviewCodeViewHarness,
} from './helpers/review-code-view.tsx';

const createCombinedFile = (contents: string, fingerprint: string) => {
  const file = createLoadedMarkdownFile(contents, fingerprint);
  return {
    ...file,
    sections: file.sections.map((section) => ({
      ...section,
      id: 'plan.md:combined:1111111111111111111111111111111111111111',
      kind: 'combined' as const,
    })),
  } satisfies ChangedFile;
};

test('combined branch Markdown edits the single combined section and refreshes after save', async () => {
  const order: Array<string> = [];
  const initialFile = createCombinedFile('# Edited\n', 'plan.md:combined-initial');
  const refreshedFile = createCombinedFile('# Saved\n', 'plan.md:combined-refreshed');
  const combinedSource = {
    baseRef: 'base123',
    headRef: 'head123',
    ref: 'main',
    type: 'branch-working-tree',
  } satisfies ReviewSource;

  markdownEditorMock.flush.mockImplementation(async () => {
    order.push('flush');
    return true;
  });

  function Harness() {
    const [file, setFile] = useState(initialFile);
    return (
      <ReviewCodeViewHarness
        files={[file]}
        onRefreshMarkdown={async () => {
          order.push('refresh');
          setFile(refreshedFile);
          return true;
        }}
        source={combinedSource}
      />
    );
  }

  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = null;

  await using _resource = {
    async [Symbol.asyncDispose]() {
      if (root) {
        await act(async () => root?.unmount());
      }
      container.remove();
    },
  };
  await act(async () => {
    root = createRoot(container);
    root.render(<Harness />);
  });
  expect(container.querySelector('[aria-label="Edit plan.md"]')).not.toBeNull();
  const diffButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    ({ textContent }) => textContent === 'View as Diff',
  );
  expect(diffButton).not.toBeUndefined();
  await act(async () => {
    diffButton?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await waitFor(() => {
    expect(container.querySelector('[aria-label="Edit plan.md"]')).toBeNull();
  });
  expect(order).toEqual(['flush', 'refresh']);
  expect(JSON.stringify(codeViewMock.lastItems)).toContain('# Saved');
});

beforeEach(() => {
  resetCodeViewMock();
  resetMarkdownEditorMock();
});

vi.mock('@nkzw/mdx-editor', async () =>
  (await import('./helpers/markdown-editor.tsx')).createMdxEditorMock(),
);

vi.mock('../app/components/MarkdownDocumentEditor.tsx', async () =>
  (await import('./helpers/markdown-editor.tsx')).createMarkdownDocumentEditorMock(),
);
