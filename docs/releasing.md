# Making a release

Cadenza updates itself from GitHub releases. A release has the installers for each system and a small file,
`latest.json`, that Cadenza reads to find out whether there's something newer. Every update is signed with a
key that only you have, and Cadenza refuses anything that isn't signed with it, so nobody else can push code
to your users through the repository.

## Once: make the update key

On any computer with Rust (the key is made by Tauri's tool; install it with `cargo install tauri-cli --version "^2" --locked` if you don't have it):

```bash
mkdir -p ~/.tauri
cargo tauri signer generate -w ~/.tauri/cadenza.key
```

It asks for a password (use one, and keep it in your password manager) and prints a **public key**. Then:

1. Paste the public key into `desktop/tauri.conf.json`, as `plugins → updater → pubkey` (it's an empty
   string until you do), and commit it. A public key is safe to commit.
2. On GitHub: Settings → Secrets and variables → Actions → New repository secret. Add
   `TAURI_SIGNING_PRIVATE_KEY` (the contents of `~/.tauri/cadenza.key`) and
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (the password).
3. **Back up `~/.tauri/cadenza.key` and its password somewhere safe, and never put them in the repository.**
   If the key is lost, nobody can be updated from the app any more: they'd have to download a new version by
   hand. If it leaks, someone could send your users a fake update.

Until the public key is in `tauri.conf.json`, Cadenza's Updates row says updates aren't set up in this copy.

## Each release

1. Raise the version, the same number in `desktop/tauri.conf.json` and `desktop/Cargo.toml`. Commit and push.
2. `./release.sh --github` (or Actions → Release → Run workflow). GitHub builds Mac, Windows and Linux, runs
   the tests on each, signs the update files and makes a **draft** release, `v<version>`, with everything on it.
3. Check the draft on GitHub, then press **Publish**. Only then can anyone's Cadenza see it.

`./release.sh` without `--github` builds only the computer you're on, copies the installers into
`build/release/` with a checksums file, and can put them on a draft release. That route has no `latest.json`,
so it won't update anyone: use it for a quick test download.

## Test it once before the first real release

The first update should be tried with a throwaway pair of versions, not with real users:

1. Make a release of the current version (say 1.0.0) and install it from the draft's installer.
2. Raise the version to 1.0.1, make a second release, and publish it.
3. Open the 1.0.0 copy: System → Updates → Check. It should offer 1.0.1; press Update, and Cadenza should close
   and come back as 1.0.1. (Don't test with the draft unpublished: the "latest" release is the newest
   published one.)

## Things to know

- **The repository has to be public** (or the update file reachable some other way). Cadenza reads
  `https://github.com/<owner>/<repo>/releases/latest/download/latest.json` without signing in, and GitHub
  doesn't serve a private repository's files to anyone who isn't logged in. In a private repository the Updates
  row says no release was found.
- **Mac permissions may be asked again after an update.** The Mac app is signed with a one-off (ad-hoc)
  signature, and macOS ties permissions to the signature, which changes with each build. Paid Apple signing
  (and notarising) removes this, and the "Open Anyway" step on first open.
- **Windows updates** run the installer, which closes Cadenza and starts it again. **Linux** updates work for
  the AppImage; the `.deb` has to be reinstalled by hand.
- **Rolling back:** publish a new release with a higher version number that has the old code. Cadenza only
  moves forward.
- Don't commit `~/.tauri/cadenza.key`. `.gitignore` skips `*.key`, but keep the key outside the project anyway.
