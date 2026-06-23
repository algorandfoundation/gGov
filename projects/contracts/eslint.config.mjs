import globals from 'globals'
import tseslint from 'typescript-eslint'
import { baseConfig } from '../../eslint.config.base.mjs'

export default tseslint.config(...baseConfig, {
  languageOptions: {
    globals: globals.node,
  },
  rules: {
    '@typescript-eslint/explicit-member-accessibility': 'warn',
  },
}, {
  ignores: ['smart_contracts/artifacts/**'],
})
