import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import pluginVue from 'eslint-plugin-vue';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'out/**',
      'build/**',
      'dist*/**',
      'engines/**',
      'resources/**',
      'plugins/**',
      'docs/**',
      // 第三方独立审计脚本（test-audit/）：非产品代码，仅用于复现审计结论
      'test-audit/**',
      // 审计/冒烟运行期在仓库根临时生成的 esbuild 产物
      '.audit-*.cjs',
      '.builder-cache/**',
      '.build-tmp/**',
      '.npm-cache/**',
      '*.log',
      '*.txt'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/recommended'],
  {
    // Vue SFC：script 使用 TypeScript 解析器
    files: ['src/**/*.vue'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser }
    }
  },
  {
    // 脚本目录：JS 脚本使用 Node 全局（无打包器），关闭 no-undef 由运行时自行暴露
    files: ['scripts/**/*.mjs', 'scripts/**/*.js'],
    rules: {
      'no-undef': 'off'
    }
  },
  {
    rules: {
      // 项目既有代码风格：在语义规则的约束下保持最小噪音
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Vue 编排规则（关闭纯样式类，保留正确性规则）
      'vue/multi-word-component-names': 'off',
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/multiline-html-element-content-newline': 'off',
      'vue/html-self-closing': 'off',
      'vue/html-indent': 'off',
      'vue/first-attribute-linebreak': 'off',
      'vue/html-closing-bracket-newline': 'off',
      'vue/attributes-order': 'off',
      'vue/no-unused-vars': 'off'
    }
  }
);
