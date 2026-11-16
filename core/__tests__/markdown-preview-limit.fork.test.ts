import { expect, test } from 'vite-plus/test';
import {
  getMarkdownPreviewContents,
  getVisibleDiffSections,
  MAX_MARKDOWN_PREVIEW_LENGTH,
} from '../lib/diff.ts';
import type { ChangedFile } from '../types.ts';

const createUntrackedMarkdown = (contents: string) =>
  ({
    fingerprint: `large-markdown:${contents.length}`,
    path: 'notes.md',
    sections: [
      {
        binary: false,
        id: 'notes.md:unstaged',
        kind: 'unstaged',
        loadState: 'ready',
        newFile: { contents, name: 'notes.md' },
        oldFile: { contents: '', name: 'notes.md' },
        patch: '',
      },
    ],
    status: 'untracked',
  }) satisfies ChangedFile;

test.each([
  ['at the limit', MAX_MARKDOWN_PREVIEW_LENGTH, true],
  ['above the limit', MAX_MARKDOWN_PREVIEW_LENGTH + 1, false],
])('Markdown %s gets a preview: %s', (_label, length, previewed) => {
  const file = createUntrackedMarkdown('x'.repeat(length));
  const [{ fileDiff, section }] = getVisibleDiffSections(file, false);

  expect(getMarkdownPreviewContents(file, section, fileDiff) != null).toBe(previewed);
});
