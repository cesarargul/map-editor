// Copia el wasm de sql.js a public/ para que GeoPackage funcione sin CDN.
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
mkdirSync(new URL('../public/', import.meta.url), { recursive: true });
copyFileSync(require.resolve('sql.js/dist/sql-wasm.wasm'), new URL('../public/sql-wasm.wasm', import.meta.url));
console.log('sql-wasm.wasm copiado a public/');
