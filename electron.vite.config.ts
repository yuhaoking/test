import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'path';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'electron/main.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'electron/preload.ts') }
      }
    }
  },
  renderer: {
    root: 'src',
    resolve: {
      alias: { '@': resolve(__dirname, 'src') }
    },
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/index.html'),
          pet: resolve(__dirname, 'src/pet.html'),
          settings: resolve(__dirname, 'src/settings.html'),
          box: resolve(__dirname, 'src/box.html'),
          palette: resolve(__dirname, 'src/palette.html'),
          deskboard: resolve(__dirname, 'src/deskboard.html'),
          // P0（T-01 / T-04）：剪贴板粘贴面板 + 截图工作流窗口
          clipboard: resolve(__dirname, 'src/clipboard.html'),
          capture: resolve(__dirname, 'src/capture.html'),
          annotate: resolve(__dirname, 'src/annotate.html'),
          pin: resolve(__dirname, 'src/pin.html'),
          long: resolve(__dirname, 'src/long.html'),
          // T-05：AI 宠物对话面板
          chat: resolve(__dirname, 'src/chat.html'),
          // T-07：划词翻译 / 取词 OCR 悬浮条
          translatebar: resolve(__dirname, 'src/translatebar.html'),
          // T-08：内置文件预览（QuickLook 兜底）
          preview: resolve(__dirname, 'src/preview.html'),
          // T-14：开发者工具百宝箱小面板（正则 / diff / 二维码 / 工具箱）
          devtools: resolve(__dirname, 'src/devtools.html')
        }
      }
    },
    plugins: [vue()]
  }
});
