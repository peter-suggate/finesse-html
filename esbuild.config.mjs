import { build, context } from 'esbuild';
import process from 'node:process';

const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  target: ['es2022'],
};

const configs = [
  {
    ...common,
    entryPoints: ['src/host/extension.ts'],
    outfile: 'dist/host/extension.js',
    platform: 'node',
    format: 'cjs',
    external: ['vscode', '@cursor/sdk', '@anthropic-ai/claude-agent-sdk'],
  },
  {
    ...common,
    entryPoints: ['src/iframe/main.ts'],
    outfile: 'dist/iframe/runtime.js',
    platform: 'browser',
    format: 'iife',
  },
  {
    ...common,
    entryPoints: ['src/webview/main.ts'],
    outfile: 'dist/webview/main.js',
    platform: 'browser',
    format: 'iife',
  },
];

if (watch) {
  await Promise.all(
    configs.map(async (cfg) => {
      const ctx = await context(cfg);
      await ctx.watch();
    }),
  );
  console.log('esbuild: watching all bundles');
} else {
  await Promise.all(configs.map((cfg) => build(cfg)));
  console.log('esbuild: build complete');
}
