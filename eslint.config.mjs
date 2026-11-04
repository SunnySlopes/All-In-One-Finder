// ESLint flat config — type-aware linting for the renderer sources.
//
// Scope: src/**/*.ts only. The native side is C/C++ (CMake), scripts/ are plain
// ESM helpers, and scripts/scratch/ is intentionally disposable, so none of them
// are linted here. `tsc --noEmit` stays the compiler gate; ESLint adds the
// defect classes TypeScript cannot see (unused code, floating promises,
// accidental `.value` on checkboxes would surface as a type error, but
// inconsistent control flow and await handling do not).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    // Build output, dependencies and the vendored native tree are not ours to lint.
    ignores: [
      'dist/**',
      'release/**',
      'node_modules/**',
      'native/**',
      'tools/**',
      'scripts/scratch/**',
      'test-results/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Already enforced by `tsc --noEmit`; duplicate diagnostics are noise.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // The UI talks to the engine over `window.__AIO_RPC__`, whose typing is
      // deliberately loose at the boundary; callers narrow with `call<T>()`.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',

      // `catch {}` around best-effort localStorage / session writes is intentional.
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',

      // Poll loops call async work inside setInterval on purpose.
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],

      // Floating promises in event handlers are the actual bug class to gate on.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      'prefer-const': 'error',
      eqeqeq: ['error', 'smart'],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  prettier,
);
