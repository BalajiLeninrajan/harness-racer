import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // OpenTUI's native renderer uses Bun FFI. Keep these behavioral tests out
    // of the ordinary Node/Vitest suite and run them through `pnpm test:tui`.
    exclude: [...configDefaults.exclude, "tests/tui-native/**"],
  },
});
