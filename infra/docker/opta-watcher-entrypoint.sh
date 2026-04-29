#!/bin/sh
set -e

chown -R opta:nogroup /data
exec runuser -u opta -m -- "$@"
