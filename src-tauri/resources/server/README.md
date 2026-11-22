The servers a Host runs, bundled into the app (docs/plans/remote-hosts.md
phase 15): `abundio-server-<platform>.gz` for linux-x86_64, linux-aarch64
and macos-universal. CI's `build` job writes them here from the `server`
job's artifacts before bundling; they are never committed. For a local
release build, put them here yourself with `pnpm server:linux-x86_64`,
`pnpm server:linux-aarch64` (Docker) and `pnpm server:macos-universal` (a
Mac); `pnpm tauri build` builds none. A development build (`pnpm tauri
dev`) uses the server built next to it instead.
