#!/bin/sh
# Quake Town — build the page once and serve it on :5191 for long browser tests: the dev
# server reloads every page whenever anyone edits a source file, which ends a 2-minute run.
# VITE_QT_PROBE=1 keeps the arrr harness probe (?probe=1) in this test build only.
# Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
set -e
cd "$(dirname "$0")/../.."
node tools/test/test-public.mjs
VITE_QT_PROBE=1 nice npx vite build --config tools/test/vite.test.config.js --outDir .cache/test-dist --emptyOutDir --logLevel warn
exec npx vite preview --config tools/test/vite.test.config.js --outDir .cache/test-dist --port 5191 --strictPort
