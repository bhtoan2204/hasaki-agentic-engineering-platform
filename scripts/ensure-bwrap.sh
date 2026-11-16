#!/bin/sh
command -v bwrap >/dev/null 2>&1 && exit 0
if command -v apt-get >/dev/null 2>&1 && [ -t 0 ]; then
  echo "bwrap not found; installing bubblewrap (needs sudo)..."
  sudo apt-get install -y bubblewrap && exit 0
fi
echo "warning: bwrap not installed; worker commands are refused unless platform.trustedOperatorIsolation is set" >&2
exit 0
