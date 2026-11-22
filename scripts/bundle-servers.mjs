#!/usr/bin/env node
// Build one server a Host runs and put it, gzipped, where a release build of
// the app bundles it from (docs/plans/remote-hosts.md phase 15):
// src-tauri/resources/server/abundio-server-<platform>.gz.
//
//   pnpm server:linux-x86_64     (Docker)
//   pnpm server:linux-aarch64    (Docker; emulated on an x86 machine, slow)
//   pnpm server:macos-universal  (a Mac: cargo for both chips, then lipo)
//
// `pnpm tauri build` bundles whatever is in that folder and builds none
// itself; CI puts all three there before it builds.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tauri = join(root, "src-tauri");
const out = join(tauri, "resources", "server");
const platforms = ["linux-x86_64", "linux-aarch64", "macos-universal"];

const platform = process.argv[2];
if (!platforms.includes(platform)) {
	console.error(
		`usage: node scripts/bundle-servers.mjs <${platforms.join("|")}>`,
	);
	process.exit(2);
}

const run = (cmd, args, opts = {}) =>
	execFileSync(cmd, args, { stdio: "inherit", cwd: root, ...opts });

/** A static (musl) Linux server, built in Docker, so any machine with
 *  Docker builds it: a Mac, Linux, or Windows with Docker Desktop. */
function buildLinux(arch) {
	const dockerPlatform = arch === "x86_64" ? "linux/amd64" : "linux/arm64";
	const dist = join(tauri, "target", "server-dist", `linux-${arch}`);
	mkdirSync(dist, { recursive: true });
	// A target folder and cargo cache of its own per arch, kept between runs.
	run("docker", [
		"run",
		"--rm",
		"--platform",
		dockerPlatform,
		"-v",
		`${tauri}:/src`,
		"-v",
		"abundio-cargo-registry:/usr/local/cargo/registry",
		"-v",
		`abundio-server-target-${arch}:/target`,
		"-e",
		"CARGO_TARGET_DIR=/target",
		"-w",
		"/src",
		"rust:1-alpine",
		"sh",
		"-euc",
		[
			"apk add --no-cache musl-dev build-base perl >/dev/null",
			"cargo build --release --locked -p abundio-server",
			`cp /target/release/abundio-server /src/target/server-dist/linux-${arch}/abundio-server`,
		].join("\n"),
	]);
	return join(dist, "abundio-server");
}

/** The Mac server for both chips in one file; only a Mac can build it. */
function buildMac() {
	if (process.platform !== "darwin") {
		console.error("the macOS server can only be built on a Mac");
		process.exit(1);
	}
	const targets = ["aarch64-apple-darwin", "x86_64-apple-darwin"];
	run("rustup", ["target", "add", ...targets]);
	for (const t of targets) {
		run(
			"cargo",
			["build", "--release", "--locked", "-p", "abundio-server", "--target", t],
			{ cwd: tauri },
		);
	}
	const universal = join(
		tauri,
		"target",
		"server-dist",
		"macos-universal",
		"abundio-server",
	);
	mkdirSync(dirname(universal), { recursive: true });
	run("lipo", [
		"-create",
		"-output",
		universal,
		...targets.map((t) => join(tauri, "target", t, "release", "abundio-server")),
	]);
	return universal;
}

const binary = platform.startsWith("linux-")
	? buildLinux(platform.slice("linux-".length))
	: buildMac();
mkdirSync(out, { recursive: true });
const gz = join(out, `abundio-server-${platform}.gz`);
writeFileSync(gz, gzipSync(readFileSync(binary), { level: 9 }));
console.log(`[server] ${platform} → ${gz}`);
