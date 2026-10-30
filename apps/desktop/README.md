# Superlocal desktop shell

A Tauri 2 shell around a compiled Superlocal host. The shell owns the host
process, serves the built web UI and the API from one loopback port, and keeps
the window on that origin.

Build and install (macOS only):

```sh
bun --no-env-file scripts/build-desktop.ts            # build the .app
bun --no-env-file scripts/build-desktop.ts --install  # install to /Applications
bun --no-env-file scripts/build-desktop.ts --install --adopt <config.json>
```

The build compiles `apps/local-host/src/index.ts` with its worker entry into one
signed sidecar, builds the web app, copies both into the bundle and ad-hoc signs
the result. Installation replaces only `/Applications/Superlocal.app`.

## Profiles

By default the app creates a fresh private profile under application data. Set
`SUPERLOCAL_DESKTOP_PROFILE` to an absolute private directory to isolate a
different fresh profile.

To adopt an existing profile in place, either pass `--adopt` to the install
script or set `SUPERLOCAL_DESKTOP_ADOPT_CONFIG` to its configuration file. The
install script records the choice in a private
`existing-config` pointer inside application configuration, so Finder launches
keep using the same profile. These options are mutually exclusive.

Adoption honors the configuration's `dataDir`, including paths relative to the
configuration file and its default application-data location. Nothing is copied,
migrated or reset: missing identity files fail startup, and the original files
must be restored rather than replaced. The child receives a sanitized
environment, so profiles whose OAuth configuration references custom
environment variables need a separate credential provisioning path.

## Host lifecycle

The shell is the only owner of the host process. It starts the host with a
one-time bootstrap secret on inherited stdin, waits for readiness on stdout,
and holds an OS lock for the profile until the host exits. Quitting the app
stops the host.

If the host dies, the shell shows a blocking reconnecting overlay, restarts it
with bounded backoff (five automatic attempts), and reloads the window with the
new session cookie. After the automatic attempts are exhausted, **Mail → Retry
Connection (⌘R)** starts it again. Durable drafts and receipts survive the
reload because they live in the host database.

Host stderr is mirrored to `~/Library/Logs/ceo.ryan.superlocal/host.log`
(owner-only, capped at 1 MiB).
