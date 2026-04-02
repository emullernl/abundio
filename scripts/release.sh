#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: pnpm run release <version>"
  echo "Example: pnpm run release 0.2.0"
  exit 1
fi

VERSION="$1"

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Error: Version must be in semver format (e.g., 1.2.3)"
  exit 1
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  echo "Error: Must be on main branch to release (currently on '$CURRENT_BRANCH')."
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: Working tree is not clean. Commit or stash changes first."
  exit 1
fi

if git tag -l "v$VERSION" | grep -q .; then
  echo "Error: Tag v$VERSION already exists."
  exit 1
fi

ROOT="$(git rev-parse --show-toplevel)"

# 1. package.json
node -e "
  const fs = require('fs');
  const p = '$ROOT/package.json';
  const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
  pkg.version = '$VERSION';
  fs.writeFileSync(p, JSON.stringify(pkg, null, '\t') + '\n');
"

# 2. src-tauri/tauri.conf.json
node -e "
  const fs = require('fs');
  const p = '$ROOT/src-tauri/tauri.conf.json';
  const conf = JSON.parse(fs.readFileSync(p, 'utf8'));
  conf.version = '$VERSION';
  fs.writeFileSync(p, JSON.stringify(conf, null, '\t') + '\n');
"

# 3. src-tauri/Cargo.toml
if [[ "$(uname)" == "Darwin" ]]; then
  sed -i '' "0,/^version = .*/s//version = \"$VERSION\"/" "$ROOT/src-tauri/Cargo.toml"
else
  sed -i "0,/^version = .*/s//version = \"$VERSION\"/" "$ROOT/src-tauri/Cargo.toml"
fi

# Update Cargo.lock without re-resolving transitive dependencies
(cd "$ROOT/src-tauri" && cargo check --quiet) || { echo "Error: cargo check failed — fix build errors before releasing."; exit 1; }

echo "Bumped version to $VERSION"
echo ""

git add "$ROOT/package.json" "$ROOT/src-tauri/tauri.conf.json" "$ROOT/src-tauri/Cargo.toml" "$ROOT/src-tauri/Cargo.lock"
git commit -m "release: v$VERSION"
git tag -a "v$VERSION" -m "Release v$VERSION"

echo ""
echo "Created commit and tag v$VERSION."
echo "Run 'git push --follow-tags' to trigger the release build."
