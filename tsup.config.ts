import { defineConfig, type Options } from "tsup";

const shared: Options = {
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: false,
  splitting: false,
  sourcemap: true,
  external: ["vite", "@opentui/core", "@opentui/react"],
};

export default defineConfig([
  {
    ...shared,
    entry: { cli: "src/cli.ts" },
    banner: { js: "#!/usr/bin/env node" },
  },
  {
    ...shared,
    entry: { tui: "src/tui-entry.ts" },
    target: "esnext",
    banner: { js: "#!/usr/bin/env bun" },
  },
]);
