import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['node_modules', 'coverage', 'test-results', 'src/types/api.d.ts'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'tests/**/*.ts', 'scripts/**/*.ts'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', fetch: 'readonly' }
    }
  },
  {
    files: ['public/js/**/*.js'],
    languageOptions: {
      globals: globals.browser
    }
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'off'
    }
  }
)
