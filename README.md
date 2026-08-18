# ObSyncer

ObSyncer is a small Obsidian plugin that synchronizes a vault through a private
GitHub repository on desktop and mobile without requiring a local Git binary.

It is designed for one person who edits one device at a time but wants protection
from delayed polling, offline edits, or an accidentally stale second device.

> **Alpha software:** version 0.1.0 is under active development. Test with a
> disposable vault and repository before trusting it with primary notes.

## The synchronization rule

The first device that successfully advances the remote `main` branch wins.
ObSyncer never force-pushes `main` and does not create merge commits.

If two devices start from commit `A`, mobile pushes `B`, and desktop has an
unpublished edit `C`, desktop performs this sequence:

1. Create a commit containing `C`.
2. Create and verify a branch such as
   `obsyncer-recovery/desktop/2026-08-18T13-30-00Z-deadbeef`.
3. Download `B` and make the local vault match it.
4. Notify the user where `C` can be recovered.

If both devices race to push, GitHub accepts only the first normal fast-forward
update. The rejected candidate automatically becomes the losing device's
recovery branch.

## Safety properties

- No force update of the coordinated branch.
- No local overwrite until a recovery ref is created and read back successfully.
- One synchronization operation at a time; triggers are coalesced.
- Local changes are detected by content scan, not only by editor events.
- `.obsidian/**`, `.git/**`, Git control files, `.trash/**`, access-token data,
  workspaces, and plugin databases are never synchronized.
- Remote files are path-validated and downloaded blobs are SHA-verified before
  use.
- An unknown two-populated-side bootstrap stops instead of guessing.

## Automatic behavior

- Local edits synchronize after three seconds of inactivity by default.
- Remote changes are polled every 15 seconds while Obsidian is visible.
- Opening the vault or returning to the foreground requests reconciliation.
- Mobile operating systems may suspend Obsidian; synchronization resumes when
  Obsidian becomes active again.

## Initial setup

Use a fine-grained GitHub token limited to one private repository with
**Contents: Read and write**.

The first setup must have one empty side:

- Existing vault + empty GitHub repository: ObSyncer initializes the remote.
- Empty vault + populated GitHub repository: ObSyncer downloads the remote.
- Existing vault + populated repository without an ObSyncer baseline: ObSyncer
  stops and changes nothing.

Do not run ObSyncer together with Obsidian Git, GitHub Gitless Sync, Obsidian
Sync, Syncthing, or another tool that writes the same vault.

## Development

```shell
pnpm install
pnpm test
pnpm build
```

Maintainers can run `pnpm test:github-live` while authenticated with GitHub CLI.
It creates a uniquely named private repository, verifies the sibling-commit race
and recovery-ref behavior against GitHub, and deletes the repository afterward.

The production build produces `main.js`. For manual installation, copy
`main.js`, `manifest.json`, and `styles.css` into:

```text
<vault>/.obsidian/plugins/obsyncer/
```

## License and attribution

ObSyncer is a fork of
[GitHub Gitless Sync](https://github.com/silvanocerza/github-gitless-sync) by
Silvano Cerza. It remains licensed under AGPL-3.0-only; see [LICENSE](LICENSE).
