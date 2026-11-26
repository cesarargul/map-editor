import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: { entry: 'src/index.ts', formats: ['es'], fileName: () => 'map-editor.js' },
    sourcemap: true,
    rollupOptions: {
      // Las dependencias se resuelven en la aplicación (sin duplicar MapLibre, Lit ni el núcleo).
      // El CSS de MapLibre sí se incrusta, porque el componente usa shadow DOM.
      external: (id) => /^(maplibre-gl|lit|@lit\/|@map-editor\/core)(\/|$)/.test(id) && !id.endsWith('.css?inline'),
    },
  },
});
