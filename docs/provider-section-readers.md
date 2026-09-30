# Native provider section readers

This is the bounded Codiff reader prerequisite for LFV #202, not the LFV
implementation or the concurrent CLI parser work. It reuses Codiff's provider
transports, file metadata, patch construction, ref resolvers, and Git blob reader.

## API for the LFV adapter

`electron/git-state.cjs` exports the existing dispatcher and the two new native
readers. The readers are also exported by their provider-owned modules:

```ts
readPullRequestSectionContent(launchPath, source, path, { force?: boolean })
readMergeRequestSectionContent(launchPath, source, path, { force?: boolean })
```

Both return `Promise<DiffSection>`. The options argument is optional. Adapter
callers can use the existing dispatcher without provider algorithms:

```ts
await readDiffSectionContent(launchPath, {
  source: {
    type: 'pull-request',
    provider: 'github',
    url: 'https://github.com/acme/widgets/pull/42',
  },
  kind: 'pull-request',
  path: 'src/app.ts',
  force: true,
});
```

GitLab uses `provider: 'gitlab'` and its native merge-request URL, including
self-hosted GitLab URLs. Dispatch also recognizes GitLab URLs when the optional
provider field is absent, matching the existing repository/image dispatch.
Provider sections never fall through to the local working-tree loader.

## Content and availability contract

- Repository state retains the provider source and canonical URL. Sections keep
  `kind: 'pull-request'` and `id: '<path>:pull-request:<number>'`.
- Membership comes from native provider files/diffs. Rename content uses the old
  path at the base and the new path at the head; additions/deletions retain their
  legitimately empty opposite side with ref-scoped cache keys.
- GitHub content uses the native merge-base resolver. GitLab uses its native
  diff-ref/merge-base resolver. Matching remotes, authorization, and fetch errors
  retain existing provider behavior; no local working-tree text is substituted.
- The native eager limit is 1 MiB per blob. A larger text blob within the 2 MiB
  manual limit produces `loadState: 'deferred'`, `summary.canLoad: true`, and its
  native size/limit summary. `force: true` requests full old/new text up to 2 MiB.
- Either side exceeding 2 MiB produces `loadState: 'too-large'` and
  `summary.canLoad: false`, even if the other side is merely deferred. Binary
  content stays binary and non-loadable. Force never bypasses the manual ceiling
  or binary classification.
- Native content can establish text availability when the provider omitted its
  patch. Existing patch-only fallbacks remain non-loadable when refs are absent.
- Invalid repository paths, nonmember files, provider authorization failures,
  unresolved refs, and missing required blobs reject with an error. An added
  file missing from the head is not reported as a successful empty text file.

## Verification evidence

Fixed review point: `aab33ec2e84d5f61b8f000b11a1907f491b55a37`.
Checkout: `/Users/hoangbn/.monke/worktrees/codiff/feature/diff-codiff-reader-202`.

- Red: the new provider test file failed all six tests before implementation:
  missing reader exports, non-loadable eager fallbacks, and local working-tree
  substitution for provider requests.
- Additional red: both providers reported a provider-listed added file with a
  missing head blob as successfully loaded empty text. Required-side checks
  now reject that case.
- Green: six provider tests pass using controlled `gh`/`glab` responses and real
  Git repositories. Tests cover rename/add/delete text, dirty-working-tree
  isolation, explicit and URL-based dispatch, omitted patches, source identity,
  eager/manual bounds on both sides, binary content, membership, authorization,
  missing blobs, and unresolved refs. SSH is disallowed during unavailable-ref
  fixtures, so those cases cannot contact live providers.
- Existing Git state and GitHub remote tests also pass: three files, 91 tests.
- Targeted `vp check --fix` passes for the three owned production modules and
  the new test file; no repo-wide check or test suite is run.
- Required `vpr build` succeeds and refreshes the ignored local build outputs.
  Build warnings concern absent web development secrets, bundle chunk sizes,
  and an ineffective existing dynamic import; none prevent the build.

Independent closeout is blocked until a separate verifier runs the installed
implement closeout procedure. No self-review, publication, PR, merge, parser
changes, or modifications to `/Applications/Codiff.app` are part of this work.
