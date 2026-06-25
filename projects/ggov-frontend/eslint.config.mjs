import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { baseConfig } from '../../eslint.config.base.mjs'

export default tseslint.config(
  { ignores: ['dist', 'storybook-static', '**/*.gen.ts', '.storybook/**'] },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended, reactRefresh.configs.vite],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'react-refresh/only-export-components': ['error', { allowConstantExport: true }],
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/purity': 'off',
    },
  },
  {
    files: ['**/routes/**/*.{ts,tsx}', 'src/components/ui/**'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
  ...baseConfig,
  {
    files: ['scripts/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
)
