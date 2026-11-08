#!/bin/sh
set -eu
exec node --env-file-if-exists=.env "$(dirname "$0")/backup-db.mjs"
