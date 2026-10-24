import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

// Mirrors backend/eslint.config.js: the same flat config, the same three layers, so both
// workspaces report the same class of problem in the same way.
//
// The .mjs extension is deliberate. The backend's package.json declares "type": "module", so a
// plain .js config is ESM there; an Expo app's package.json must stay CommonJS for Metro, which
// would make a plain .js config CommonJS here and break the imports above.
export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    ignores: ['node_modules/', '.expo/', 'web-build/', 'coverage/'],
  },
  {
    // The one CommonJS file in the workspace: Jest reads its config before any transform runs.
    files: ['jest.config.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { module: 'writable', require: 'readonly', __dirname: 'readonly' },
    },
  },
);
