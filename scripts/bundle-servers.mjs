#!/usr/bin/env node
// Put the servers a Host runs into the app's resources, gzipped
// (docs/plans/remote-hosts.md phase 15): src-tauri/resources/server/
// abundio-server-<platform>.gz for linux-x86_64, linux-aarch64 and
// macos-universal, plus a VERSION stamp.
//
//   node scripts/bundle-servers.mjs        (also run by `pnpm tauri build`)
//
// Skips when all three are there for this app's version (CI puts them there
// before it builds). Otherwise builds them: the Linux ones in Docker
// (scripts/build-server-linux.sh), the Mac one with cargo and lipo, which
// needs a Mac. ABUNDIO_SKIP_SERVER_BUNDLE=1 skips it all, for a quick local
// build whose Install then has no server to upload.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "src-tauri", "resources", "server");
const platforms = ["linux-x86_64", "linux-aarch64", "macos-universal"];
const version = JSON.parse(
	readFileSync(join(root, "package.json"), "utf8"),
).version;

const gzName = (p) => join(out, `abundio-server-${p}.gz`);
const stamp = join(out, "VERSION");

if (process.env.ABUNDIO_SKIP_SERVER_BUNDLE === "1") {
	console.warn(
		"[servers] ABUNDIO_SKIP_SERVER_BUNDLE=1: this build bundles no servers",
	);
	process.exit(0);
}

const current =
	existsSync(stamp) && readFileSync(stamp, "utf8").trim() === version;
if (current && platforms.every((p) => existsSync(gzName(p)))) {
	console.log(`[servers] already bundled for ${version}`);
	process.exit(0);
}

const run = (cmd, args, opts = {}) =>
	execFileSync(cmd, args, { stdio: "inherit", cwd: root, ...opts });

function build(platform) {
	if (platform.startsWith("linux-")) {
		const arch = platform.slice("linux-".length);
		run("sh", ["scripts/build-server-linux.sh", arch]);
		return join(
			root,
			"src-tauri",
			"target",
			"server-dist",
			platform,
			"abundio-server",
		);
	}
	if (process.platform !== "darwin") {
		throw new Error(
			"the macOS server can only be built on a Mac; build there, or set ABUNDIO_SKIP_SERVER_BUNDLE=1",
		);
	}
	const targets = ["aarch64-apple-darwin", "x86_64-apple-darwin"];
	run("rustup", ["target", "add", ...targets]);
	for (const t of targets) {
		run("cargo", ["build", "--release", "-p", "abundio-server", "--target", t], {
			cwd: join(root, "src-tauri"),
		});
	}
	const universal = join(
		root,
		"src-tauri",
		"target",
		"server-dist",
		platform,
		"abundio-server",
	);
	mkdirSync(dirname(universal), { recursive: true });
	run("lipo", [
		"-create",
		"-output",
		universal,
		...targets.map((t) =>
			join(root, "src-tauri", "target", t, "release", "abundio-server"),
		),
	]);
	return universal;
}

mkdirSync(out, { recursive: true });
for (const p of platforms) {
	console.log(`[servers] building ${p}…`);
	const binary = build(p);
	writeFileSync(gzName(p), gzipSync(readFileSync(binary), { level: 9 }));
	console.log(`[servers] bundled ${p}`);
}
writeFileSync(stamp, `${version}\n`);
console.log(`[servers] bundled all three for ${version}`);
