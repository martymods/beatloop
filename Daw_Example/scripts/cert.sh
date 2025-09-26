#!/usr/bin/env bash
set -euo pipefail
echo "mkcert localhost"
cd packages/app && mkcert localhost || exit 1