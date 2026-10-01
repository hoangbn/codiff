import type { FileContents } from '@pierre/diffs';
import { useState } from 'react';

export function useCodeViewPlaceholderFile() {
  const [getPlaceholderFile] = useState(() => {
    const files = new Map<string, FileContents>();

    return (name: string, contents: '' | ' ' = ' '): FileContents => {
      const cacheKey = `placeholder:${contents.length}:${name}`;
      let file = files.get(cacheKey);
      if (!file) {
        file = { cacheKey, contents, lang: 'text', name };
        files.set(cacheKey, file);
      }
      return file;
    };
  });

  // VirtualizedFile prepares layout using the cached file object, then checks
  // its identity against the rendered file. Keep these objects for the viewer's
  // lifetime; preview content and layout changes belong to annotations/version.
  return getPlaceholderFile;
}
