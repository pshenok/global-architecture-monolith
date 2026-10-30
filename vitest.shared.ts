import swc from 'unplugin-swc';
import { defineConfig, type ViteUserConfig } from 'vitest/config';

/**
 * Shared Vitest config for every workspace package.
 * - SWC (not Vite's oxc) transforms tests, so decorator metadata is identical to the build.
 * - The `@gam/source` export condition makes workspace packages resolve to their TS sources.
 * - Each package keeps its own cache: turbo starts every package's tests at once, and a
 *   cache shared at the root is cleared by one run while another starts (ENOTEMPTY).
 */
export function sharedConfig(overrides: ViteUserConfig['test'] = {}): ViteUserConfig {
  return defineConfig({
    cacheDir: 'node_modules/.vitest',
    ssr: { resolve: { conditions: ['@gam/source'] } },
    plugins: [swc.vite({ swcrc: false, module: { type: 'es6' } })],
    test: {
      environment: 'node',
      include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
      testTimeout: 20_000,
      ...overrides,
    },
  });
}
