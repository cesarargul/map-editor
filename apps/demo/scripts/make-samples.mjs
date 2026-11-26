// Genera los datos de ejemplo de la demo con los propios escritores del núcleo.
// Uso: pnpm --filter @map-editor/core build && pnpm --filter demo samples
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { configureSqlJs, writeLayer } from '../../../packages/core/dist/io/index.js';
import { FeatureStore } from '../../../packages/core/dist/store/store.js';
import { transformGeometry } from '../../../packages/core/dist/crs/crs.js';

const require = createRequire(import.meta.url);
configureSqlJs(require.resolve('sql.js/dist/sql-wasm.wasm'));
const out = (name) => new URL(`../public/samples/${name}`, import.meta.url);
const wgs = (g) => transformGeometry(g, 'EPSG:25830', 'EPSG:4326');

async function save(name, source, features, fields, opts = {}) {
  const store = new FeatureStore();
  const info = store.addLayer({ name, source, features, fields });
  const res = await writeLayer(info, store.getFeatures(info.id), opts);
  writeFileSync(out(res.fileName), res.data);
  console.log('→', res.fileName, res.warnings.join(' | '));
}

// Red de abastecimiento: tuberías enterradas (Z ≈ 650 m), ETRS89 / UTM 30N
await save(
  'red_abastecimiento',
  { format: 'geojson', fileName: 'red_abastecimiento', crs: 'EPSG:25830', hasZ: true },
  [
    { geometry: wgs({ type: 'LineString', coordinates: [[440000, 4474000, 650], [440200, 4474000, 650], [440200, 4474150, 649.5]] }), properties: { codigo: 'T-001', material: 'Fundición dúctil', diametro: 300, presion: 6.5 }, id: 1 },
    { geometry: wgs({ type: 'LineString', coordinates: [[440200, 4474000, 650], [440350, 4474000, 650.2]] }), properties: { codigo: 'T-002', material: 'PEAD', diametro: 160, presion: 6 }, id: 2 },
    { geometry: wgs({ type: 'LineString', coordinates: [[440350, 4474000, 650.2], [440350, 4473850, 650.8]] }), properties: { codigo: 'T-003', material: 'PEAD', diametro: 110, presion: 5.5 }, id: 3 },
  ],
  [
    { name: 'codigo', type: 'string' },
    { name: 'material', type: 'string' },
    { name: 'diametro', type: 'integer' },
    { name: 'presion', type: 'number' },
  ],
);

// Calles en superficie (Z ≈ 651,5 m): cruzan las tuberías en planta, pero no a la misma cota
await save(
  'calles',
  { format: 'geojson', fileName: 'calles', crs: 'EPSG:4326', hasZ: true },
  [
    { geometry: wgs({ type: 'LineString', coordinates: [[440100, 4473900, 651.5], [440100, 4474250, 651.8]] }), properties: { nombre: 'Calle de Alcalá', tipo: 'Avenida' } },
    { geometry: wgs({ type: 'LineString', coordinates: [[439950, 4474100, 651.6], [440450, 4474100, 651.9]] }), properties: { nombre: 'Calle de Atocha', tipo: 'Calle' } },
  ],
  [
    { name: 'nombre', type: 'string' },
    { name: 'tipo', type: 'string' },
  ],
);

// Parcelas (2D) como Shapefile comprimido
await save(
  'parcelas',
  { format: 'shapefile', fileName: 'parcelas', crs: 'EPSG:25830', hasZ: false },
  [
    { geometry: wgs({ type: 'Polygon', coordinates: [[[440010, 4474010], [440090, 4474010], [440090, 4474090], [440010, 4474090], [440010, 4474010]]] }), properties: { refcat: '9872023VH5797S', uso: 'Residencial', superficie: 6400 } },
    { geometry: wgs({ type: 'Polygon', coordinates: [[[440110, 4474010], [440190, 4474010], [440190, 4474090], [440110, 4474090], [440110, 4474010]], [[440130, 4474030], [440130, 4474070], [440170, 4474070], [440170, 4474030], [440130, 4474030]]] }), properties: { refcat: '9872024VH5797S', uso: 'Equipamiento (patio)', superficie: 4800 } },
  ],
  [
    { name: 'refcat', type: 'string' },
    { name: 'uso', type: 'string' },
    { name: 'superficie', type: 'number' },
  ],
);

// Hidrantes 3D en GeoPackage
await save(
  'hidrantes',
  { format: 'gpkg', fileName: 'hidrantes', crs: 'EPSG:25830', hasZ: true, formatOptions: { table: 'hidrantes' } },
  [
    { geometry: wgs({ type: 'Point', coordinates: [440200, 4474150, 651.4] }), properties: { codigo: 'H-01', operativo: true }, id: 1 },
    { geometry: wgs({ type: 'Point', coordinates: [440350, 4473850, 651.6] }), properties: { codigo: 'H-02', operativo: false }, id: 2 },
  ],
  [
    { name: 'codigo', type: 'string' },
    { name: 'operativo', type: 'boolean' },
  ],
);
