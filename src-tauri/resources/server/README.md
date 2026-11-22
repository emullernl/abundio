The servers a Host runs, bundled into the app (docs/plans/remote-hosts.md
phase 15): `abundio-server-<platform>.gz` for linux-x86_64, linux-aarch64
and macos-universal. CI's `build` job writes them here from the `server`
job's artifacts before bundling (with a VERSION stamp); they are never
committed. A local `pnpm tauri build` makes them itself
(`scripts/bundle-servers.mjs`, needing Docker and a Mac), unless they are
already here for this version; `ABUNDIO_SKIP_SERVER_BUNDLE=1` skips that.
A development build (`pnpm tauri dev`) uses the server built next to it.
