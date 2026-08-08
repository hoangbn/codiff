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

## Sidebar placement

The `ReviewSurface` interface accepts an optional `sidebarPosition` of `left` (the default) or
`right`. The exported `SidebarPosition` type can be used when the value is selected dynamically:

```tsx
import { ReviewSurface, type SidebarPosition } from '@nkzw/codiff-core/react';

const sidebarPosition: SidebarPosition = 'right';

<ReviewSurface sidebarPosition={sidebarPosition} snapshot={snapshot} />;
```
