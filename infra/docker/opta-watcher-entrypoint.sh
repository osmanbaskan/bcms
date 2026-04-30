#!/bin/sh
set -e

chown -R opta:nogroup /data
export HOME=/data
exec runuser -u opta -- env HOME=/data "$@"
