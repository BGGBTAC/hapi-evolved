#!/bin/sh
# Use the same source CLI as the managed runner, without a separate global package.
exec /usr/local/bin/bun /app/cli/src/index.ts "$@"
