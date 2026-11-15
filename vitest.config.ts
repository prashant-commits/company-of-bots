import { configDefaults, defineConfig } from 'vitest/config';

// Every test run gets its own temp folder (TMPDIR), removed when the run ends, so no test can leave
// temp repos or large files behind in the OS temp dir, including tests that create their own temp dirs.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '.cadai/**', '.superpowers/**'],
    globalSetup: ['./packages/core/test/global-setup.ts'],
  },
});
