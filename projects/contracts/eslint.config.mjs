import globals from 'globals'
import tseslint from 'typescript-eslint'
import { baseConfig } from '../../eslint.config.base.mjs'

export default tseslint.config(
  ...baseConfig,
  {
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['**/*.algo.ts'],
    rules: {
      '@typescript-eslint/explicit-member-accessibility': 'off',
    },
  },
  {
    files: ['**/common-tests.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    ignores: ['smart_contracts/artifacts/**'],
  },
)
