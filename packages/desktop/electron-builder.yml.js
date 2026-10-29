/**
 * electron-builder configuration for the macOS app.
 *
 * Layout inside the packaged app (Electron's `resources/`):
 *
 *   resources/backend/server.cjs      the bundled API server (one file)
 *   resources/backend/node_modules/node-pty
 *                                     the native PTY addon, built for Node's ABI
 *                                     (scripts/build-native.mjs)
 *   resources/web/                    the built web UI
 *
 * `app` (the bundle) and `web` come from `extraResources`, not from the asar
 * `files` list: a native module cannot be `require`d from inside `app.asar`,
 * and the server bundle resolves `node-pty` relative to itself. The asar holds
 * just the window entry point (`src/main.mjs`); everything else the app needs
 * at runtime is in `resources/`.
 */
export default {
  appId: "com.agentfabric.desktop",
  productName: "AgentFabric",
  // Pinned so the binary electron-builder downloads matches the Electron in
  // node_modules (electron-builder cannot resolve a "^" range on its own).
  electronVersion: "39.8.10",
  // The app has no dependencies of its own to install: the server is a single
  // bundle and the only native module (node-pty) is copied in by
  // `extraResources`. Without this electron-builder tries to rebuild a
  // dependency tree for the app package and fails on the workspace layout.
  npmRebuild: false,
  copyright: "AgentFabric",
  // Only the Electron main process is packed into the asar; the server bundle,
  // web assets and native addon are unpacked resources (see extraResources).
  files: ["src/main.js", "src/preload.js", "package.json"],
  asar: true,
  directories: {
    output: "release",
    buildResources: "build",
  },
  extraResources: [
    // Separate destinations: electron-builder treats a destination directory
    // with several sources as a merge point, and a later entry silently
    // replaced an earlier file when they shared `app/` — leaving the server's
    // own `node_modules` tree behind as `app.node_modules` and dropping what
    // was already copied.
    { from: "backend/server.cjs", to: "backend/server.cjs" },
    { from: "../../packages/web/dist", to: "web" },
    // The addon package, staged beside the server so `require("node-pty")`
    // resolves from `backend/node_modules/` — the lookup path the bundle's
    // location provides.
    { from: "native/node-pty", to: "backend/node_modules/node-pty" },
  ],
  mac: {
    category: "public.app-category.developer-tools",
    // Only the .app is electron-builder's job. The dmg is built by
    // `scripts/build-dmg.mjs` (`hdiutil`, built into macOS): electron-builder's
    // dmg target needs a `dmgbuild` toolchain that is downloaded from GitHub
    // release assets on first use, which fails on restricted networks — and a
    // dmg is only "the .app plus an /Applications link", which hdiutil does
    // without any download. One architecture per run: the Node runtime the app
    // ships is Electron's binary for that arch.
    target: ["dir"],
    // Unsigned ad-hoc build: no Apple Developer identity is assumed. Users open
    // it with right-click → Open, or xattr -dr com.apple.quarantine.
    identity: null,
    hardenedRuntime: false,
    darkModeSupport: true,
  },
  // Resolved relative to the *repository* root by electron-builder (the
  // workspace root it detects from the lock file), not to this file.
  afterPack: "./packages/desktop/scripts/after-pack.mjs",
};
