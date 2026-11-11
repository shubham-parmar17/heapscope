# Allocator Lab frontend

The frontend is a React and TypeScript app built with Vite. It loads the allocator WebAssembly module from `public/wasm/` and provides interactive arena, pool, free-list, pointer, and benchmark views.

## Run locally

From the repository root, build the WebAssembly files first if `frontend/public/wasm/alloclab.{mjs,wasm}` are missing or need to be refreshed:

```bash
source ~/emsdk/emsdk_env.sh  # adjust this path to your Emscripten SDK
cpp/wasm/build_wasm.sh
node cpp/wasm/smoke.mjs
```

Then install dependencies and start the Vite development server:

```bash
cd frontend
yarn install
yarn start
```

The project pins Yarn 1.22.22. If the `yarn` command is missing, install that version with `npm install --global yarn@1.22.22`. Open [http://localhost:3000](http://localhost:3000).

## Checks and production build

Run these commands from `frontend/`:

```bash
yarn typecheck
yarn build
yarn preview
```

`typecheck` runs TypeScript without emitting files. `build` creates the production bundle in `dist/`; `preview` serves that bundle locally after the build.

The allocator visualizer works locally without the API backend. Sign-in and saved-run features require the backend and its configured services; see the repository root README for the backend details.
