# @nkzw/codiff-core

Reusable code diffing primitives from Codiff.

## Example

```tsx
import type { SharedWalkthroughSnapshot } from '@nkzw/codiff-core';
import { ReviewSurface } from '@nkzw/codiff-core/react';
import '@nkzw/codiff-core/styles.css';

export function Review({ snapshot }: { snapshot: SharedWalkthroughSnapshot }) {
  return <ReviewSurface snapshot={snapshot} />;
}
```

## Deferred content

`ReviewSurface` accepts one optional `contentLoader` for deferred text sections and supported image
previews. Codiff builds requests from the snapshot source and preferences, owns loading and failure
state, and keeps the surface read-only unless its separate commenting or interactive contracts are
provided.

```tsx
import { ReviewSurface, type ReviewContentLoader } from '@nkzw/codiff-core/react';

const contentLoader: ReviewContentLoader = {
  loadImageContent: (request) => host.loadImage(request),
  loadSectionContent: (request) => host.loadSection(request),
};

<ReviewSurface contentLoader={contentLoader} initialMode="tree" snapshot={snapshot} />;
```

## Sidebar placement

Set `sidebarPosition="right"` to place the sidebar on the right; the default is `left`.

```tsx
<ReviewSurface sidebarPosition="right" snapshot={snapshot} />
```
