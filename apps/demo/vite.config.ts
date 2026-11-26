import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// En desarrollo se usan las fuentes de los paquetes (HMR sin compilar).
export default defineConfig({
  // Rutas relativas: la demo funciona igual en la raíz de un dominio que en GitHub Pages (/map-editor/)
  base: './',
  resolve: {
    alias: {
      '@map-editor/web-component': fileURLToPath(new URL('../../packages/web-component/src/index.ts', import.meta.url)),
      '@map-editor/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
    },
  },
  optimizeDeps: { exclude: ['gdal3.js'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  server: { port: 5173 },
  preview: { port: 4173 },
});
