# Desktop launch contract

Both `bin/codiff.js` and the packaged `bin/codiff-app` helper advertise
`desktop-source-v1` alongside `--capabilities` in their safe `--help` output.
`codiff --capabilities` exits without opening a window and prints:

```json
{
  "version": 1,
  "sources": ["working-tree", "commit", "branch-working-tree", "range", "pull-request"]
}
```

Integrators must check this advertisement before probing capabilities: older
desktop helpers can ignore an unknown flag and open a working-tree comparison.
A release version alone does not prove desktop launch semantics.

The helper forwards a positional `base..head` or `base...head` unchanged to
Electron, after validating both revisions in the selected repository. It never
turns a range into `--branch` or `--commit`. Direct ranges compare endpoints;
three-dot ranges compare the merge base against the head. Neither includes local
edits. Invalid range revisions passed to the shell helper fail before opening
the application.

Both the Node launcher and native Electron entry retain explicit range identity
even when an endpoint does not resolve. The Git-state loader reports that error
instead of loading the working tree. This also covers a ref disappearing after
the shell helper validates it but before Electron resolves it.

The executable contract proof in `core/__tests__/codiff-cli.test.ts` launches the
helper, feeds its actual Electron arguments through the native application entry,
and reads repository content using the application's Git-state loader. Its
diverged fixture proves that only the direct range includes the unrelated base
branch file, and that neither comparison includes an untracked working-tree file.
