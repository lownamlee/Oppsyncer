# Oppsyncer

Oppsyncer is a small Obsidian plugin that synchronizes a vault through a private
GitHub repository on desktop and mobile without requiring a local Git binary.

It is designed for one person who edits one device at a time but wants protection
from delayed polling, offline edits, or an accidentally stale second device.

> **Public beta:** Oppsyncer is under active development. Test with a
> disposable vault and repository before trusting it with primary notes.

## The synchronization rule

The first device that successfully advances the remote `main` branch wins.
Oppsyncer never force-pushes `main` and does not create merge commits.

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
- `.obsidian` synchronization is opt-in. Oppsyncer's credential/state file,
  workspaces, caches, file-recovery state, Obsidian Sync configuration, legacy
  sync metadata, SQLite sidecars, `.git/**`, Git control files, and `.trash/**`
  are never synchronized.
- Remote files are path-validated and downloaded blobs are SHA-verified before
  use.
- An unknown two-populated-side bootstrap stops instead of guessing.

## Automatic behavior

- Local edits synchronize after two seconds of inactivity by default.
- Remote changes are polled every five seconds by default. Desktop polling keeps
  running while the Obsidian window is hidden or minimized, as long as the app
  itself remains open.
- Opening the vault or returning to the foreground requests reconciliation.
- Mobile operating systems may suspend Obsidian; synchronization resumes when
  Obsidian becomes active again.

Common small edits use GitHub's atomic commit mutation: the expected remote head,
file changes, commit, and branch update are handled in one request. A stale device
is rejected before the branch moves and follows the same verified recovery path.
Large batches retain the Git Database fallback. Unchanged remote polls use ETags,
and unchanged local files reuse their size, modification time, and verified Git
blob hash.

## Obsidian configuration

Enable **Sync Obsidian configuration** to synchronize safe files under the
vault's configuration folder, normally `.obsidian`. This includes application
settings, hotkeys, themes, snippets, community-plugin code and settings, and
stable plugin data such as LearnKit's committed SQLite database files.

Hidden configuration changes are discovered by startup/foreground scans and a
periodic full inventory. Some settings and newly downloaded plugins require an
Obsidian restart before the app uses them.

The following remain device-local regardless of user exclusions:

- `.obsidian/plugins/obsyncer/data.json*` (GitHub token and sync baseline)
- `.obsidian/workspace*.json`, caches, and file-recovery state
- `.obsidian/sync.json` and legacy Git sync metadata/logs
- live SQLite `-wal`, `-shm`, and `-journal` sidecars

Other community plugins may store their own credentials in `data.json`. Add
those paths under **Additional exclusions** before enabling configuration sync.

## Initial setup

Oppsyncer requires a private GitHub repository and a fine-grained GitHub token
limited to that repository with **Contents: Read and write**.

1. Install and enable Oppsyncer on the device that already contains your notes.
2. Open **Settings → Oppsyncer**, enter the token, repository owner, repository
   name, branch, and a recognizable device name.
3. Select **Test**, then **Sync now**. Use an empty GitHub repository for this
   first upload.
4. Install Oppsyncer on the second device and enter the same repository details
   with a different device name. Start with an empty vault, then select
   **Sync now** to download the remote vault.
5. Leave **Automatic synchronization** enabled. Oppsyncer syncs after local edits
   settle and polls for remote changes while the app is active.

The local vault name is only a display name. For example, a desktop vault named
`Obsidian Vault` and a mobile vault named `Testing` can safely use the same
repository. Oppsyncer pairs them using a repository identity stored at
`.obsyncer/vault.json`; it does not require folder or vault names to match.

The first setup must have one empty side:

- Existing vault + empty GitHub repository: Oppsyncer initializes the remote.
- Empty vault + populated GitHub repository: Oppsyncer downloads the remote.
- Existing vault + populated repository without an Oppsyncer baseline: Oppsyncer
  stops and changes nothing.

Do not run Oppsyncer together with Obsidian Git, GitHub Gitless Sync, Obsidian
Sync, Syncthing, or another tool that writes the same vault.

## Data and privacy disclosures

- **Account and network access:** Oppsyncer requires a GitHub account and sends
  requests to `api.github.com` for only the repository configured in its
  settings. The recovery command can open the configured repository on
  `github.com`.
- **Vault access:** The plugin reads and writes included files inside the active
  vault. If configuration sync is enabled, it also accesses the vault's actual
  Obsidian configuration directory through Obsidian's adapter API. It does not
  access files outside the vault.
- **Credential storage:** The fine-grained GitHub token is stored locally using
  Obsidian's plugin data API. The field is masked in settings and Oppsyncer's data
  file is permanently excluded from synchronization, but the token is not
  encrypted at rest by this plugin.
- **No tracking or monetization:** Oppsyncer contains no telemetry, analytics,
  advertisements, payments, or paid features.

## Development

```shell
pnpm install
pnpm run check
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

Oppsyncer is a fork of
[GitHub Gitless Sync](https://github.com/silvanocerza/github-gitless-sync) by
Silvano Cerza. It remains licensed under AGPL-3.0-only; see [LICENSE](LICENSE).
