#!/usr/bin/env bash
# build_wasm.sh — compiles bindings.cpp with Emscripten into an ES module + .wasm pair and copies
# them into the frontend's public/ folder, where they are served as static files (no bundler magic).
# Usage: cpp/wasm/build_wasm.sh   (requires `source ~/emsdk/emsdk_env.sh` or em++ on PATH)
#
# Interview Q&A
# Q: Why MODULARIZE + EXPORT_ES6?  A: Emits `export default createModule` so the UI does
#    `const m = await createModule()` — no globals, and several instances are possible.
# Q: Why ALLOW_MEMORY_GROWTH?  A: Benchmarks with 2M blocks need >16MB; without it allocation fails.
# Q: Why -O2 and not -O3?  A: -O3 gives marginal speed for noticeably longer compile; -O2 keeps the
#    wasm small and the timings representative.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-$HERE/../../frontend/public/wasm}"
mkdir -p "$OUT"

em++ -std=c++17 -O2 \
  -I"$HERE/../include" \
  "$HERE/bindings.cpp" \
  -lembind \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createAllocLab \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=32MB \
  -sEXPORTED_RUNTIME_METHODS=HEAPU8 \
  -sENVIRONMENT=web,node \
  -o "$OUT/alloclab.mjs"

ls -la "$OUT"
