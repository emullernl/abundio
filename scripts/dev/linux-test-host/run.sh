#!/bin/sh
# Start (or restart) the Linux test Host: ssh on localhost:2222 as `dev`,
# with your public key. See the Dockerfile.
#
#   scripts/dev/linux-test-host/run.sh [path/to/key.pub]
#   scripts/dev/linux-test-host/run.sh --stop
set -eu
cd "$(dirname "$0")"
name=abundio-linux-host
if [ "${1:-}" = "--stop" ]; then
  docker rm -f "$name" >/dev/null 2>&1 || true
  echo "stopped $name"
  exit 0
fi
key="${1:-}"
if [ -z "$key" ]; then
  for k in "$HOME/.ssh/id_ed25519.pub" "$HOME/.ssh/id_ecdsa.pub" "$HOME/.ssh/id_rsa.pub"; do
    [ -f "$k" ] && key="$k" && break
  done
fi
[ -n "$key" ] && [ -f "$key" ] || { echo "no public key found; pass one" >&2; exit 1; }
docker build -q -t abundio-linux-host . >/dev/null
docker rm -f "$name" >/dev/null 2>&1 || true
# systemd as PID 1 needs the cgroup tree and a few tmpfs mounts.
docker run -d --name "$name" --hostname linux-host \
  --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  --tmpfs /run --tmpfs /run/lock \
  -p 127.0.0.1:2222:22 \
  abundio-linux-host >/dev/null
docker cp "$key" "$name:/home/dev/.ssh/authorized_keys"
docker exec "$name" sh -c 'chown dev:dev /home/dev/.ssh/authorized_keys && chmod 600 /home/dev/.ssh/authorized_keys'
echo "$name runs: ssh -p 2222 dev@localhost"
