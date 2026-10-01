import type { LineAnnotation } from '@pierre/diffs';
import { useState } from 'react';
import type { ReviewAnnotationMetadata } from '../../lib/app-types.ts';

export function useCodeViewAnnotations() {
  const [getAnnotations] = useState(() => {
    const cache = new Map<
      string,
      { annotations: Array<LineAnnotation<ReviewAnnotationMetadata>>; key: string }
    >();

    return (
      id: string,
      key: string,
      annotations: Array<LineAnnotation<ReviewAnnotationMetadata>>,
    ) => {
      const previous = cache.get(id);
      if (previous?.key === key) {
        return previous.annotations;
      }
      cache.set(id, { annotations, key });
      return annotations;
    };
  });

  // Pierre invalidates measured line heights when the annotation array changes.
  // Layout-only updates must retain the array, including while an item is recycled.
  return getAnnotations;
}
