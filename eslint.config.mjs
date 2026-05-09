// ESLint v9 flat config. typescript-eslint recommended preset.
import tseslint from 'typescript-eslint';
import js from '@eslint/js';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', '*.vsix', 'fixtures/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
);
