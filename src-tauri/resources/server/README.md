The servers a Host runs, bundled into the app (docs/plans/remote-hosts.md
phase 15): `abundio-server-<platform>.gz` for linux-x86_64, linux-aarch64
and macos-universal. CI's `build` job writes them here from the `server`
job's artifacts before bundling; they are never committed. A local or
development build has none and uses the server built next to it.
