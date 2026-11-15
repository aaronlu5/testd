import { globalIgnores } from 'eslint/config'
import { defineConfigWithVueTs, vueTsConfigs } from '@vue/eslint-config-typescript'
import pluginVue from 'eslint-plugin-vue'
import skipFormatting from '@vue/eslint-config-prettier/skip-formatting'

export default defineConfigWithVueTs(
  { name: 'app/files-to-lint', files: ['**/*.{ts,mts,tsx,vue}'] },
  globalIgnores([
    '**/dist/**',
    '**/coverage/**',
    '**/playwright-report/**',
    '**/test-results/**',
    'e2e/.runtime/**',
  ]),
  pluginVue.configs['flat/essential'],
  vueTsConfigs.recommended,
  skipFormatting,
  {
    // Route entry files are named `index.vue` and the icon wrapper is deliberately `Icon`.
    name: 'app/allowed-single-word-components',
    files: ['src/views/**/index.vue', 'src/components/ui/Icon.vue'],
    rules: { 'vue/multi-word-component-names': 'off' },
  },
)
