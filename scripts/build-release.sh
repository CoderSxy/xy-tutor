#!/bin/sh
# Local/CI build only. Export Linux files; never build on the production ECS.
set -eu
ROOT_DIR=$(CDPATH= cd "$(dirname "$0")/.." && pwd -P)
cd "$ROOT_DIR"
PLATFORM=${RELEASE_PLATFORM:-linux/amd64}
case "$PLATFORM" in
  linux/amd64) ARCH=amd64 ;;
  linux/arm64) ARCH=arm64 ;;
  *) echo 'RELEASE_PLATFORM must be linux/amd64 or linux/arm64' >&2; exit 2 ;;
esac
command -v docker >/dev/null 2>&1 || { echo 'Docker is required on the build machine' >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo 'Start Docker on the build machine, then retry' >&2; exit 1; }
mkdir -p dist
WORK_DIR=$(mktemp -d "$ROOT_DIR/dist/.release.XXXXXX")
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup 0
trap 'exit 1' 1 2 3 15
# No --push: a local exporter writes a directory, not a registry image.
docker buildx build --platform "$PLATFORM" --file infra/Dockerfile \
  --target release --output "type=local,dest=$WORK_DIR/files" .
for required in backend/dist/server/apps/server/src/main.js \
  backend/dist/server/packages/db/src/migrate.js \
  backend/dist/server/packages/db/migrations/meta/_journal.json \
  backend/dist/admin/scripts/create-admin.js web/index.html \
  deploy/xy-tutor.service deploy/nginx.conf; do
  test -s "$WORK_DIR/files/$required" || { echo "Missing artifact: $required" >&2; exit 1; }
done
test -d "$WORK_DIR/files/backend/node_modules"
# Keep environment files and source-controlled build metadata out of the package.
if find "$WORK_DIR/files" -name '.env' -o -name '.env.*' -o -name '.git' | grep -q .; then
  echo 'Unexpected environment or Git data in artifact' >&2; exit 1
fi
ARCHIVE="xy-tutor-linux-$ARCH.tar.gz"
if [ "$(uname -s)" = Darwin ]; then
  COPYFILE_DISABLE=1 tar --no-xattrs --disable-copyfile --exclude '._*' \
    -czf "$WORK_DIR/$ARCHIVE" -C "$WORK_DIR/files" backend web deploy
else
  tar --exclude '._*' -czf "$WORK_DIR/$ARCHIVE" -C "$WORK_DIR/files" backend web deploy
fi
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$WORK_DIR" && sha256sum "$ARCHIVE" > "$ARCHIVE.sha256")
else
  (cd "$WORK_DIR" && shasum -a 256 "$ARCHIVE" > "$ARCHIVE.sha256")
fi
# Only replace output after every build and validation step succeeds.
mv "$WORK_DIR/$ARCHIVE" "dist/$ARCHIVE"
mv "$WORK_DIR/$ARCHIVE.sha256" "dist/$ARCHIVE.sha256"
echo "Built dist/$ARCHIVE and dist/$ARCHIVE.sha256"
cat "dist/$ARCHIVE.sha256"
