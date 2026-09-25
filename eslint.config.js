import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Plain-Node scripts (.mjs — the demo harness). TS files are exempt from
    // no-undef by typescript-eslint; these aren't, so name the globals.
    files: ['**/*.mjs'],
    languageOptions: {
      globals: {
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
      },
    },
  },
);
