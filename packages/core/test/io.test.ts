import { DOMParser } from '@xmldom/xmldom';
import JSZip from 'jszip';
import { createRequire } from 'node:module';
import { configureSqlJs, readFiles, setXmlParser, writeLayer } from '../src/io/index.js';
import { FeatureStore } from '../src/store/store.js';
import { transformGeometry } from '../src/crs/crs.js';
import type { EditorFeature, LayerInfo } from '../src/types.js';

const require = createRequire(import.meta.url);
setXmlParser(DOMParser as never);
configureSqlJs(require.resolve('sql.js/dist/sql-wasm.wasm'));

const enc = (s: string) => new TextEncoder().encode(s);

/** Red de tuberías en ETRS89 / UTM 30N con cotas (Madrid). */
const UTM_FC = {
  type: 'FeatureCollection',
  crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::25830' } },
  features: [
    { type: 'Feature', id: 1, properties: { nombre: 'Tubería Ñandú', diametro: 300, material: 'fundición', activa: true }, geometry: { type: 'LineString', coordinates: [[440000, 4474000, 655.5], [440100, 4474050, 657.25]] } },
    { type: 'Feature', id: 2, properties: { nombre: 'Arqueta', diametro: 0.5, material: null, activa: false }, geometry: { type: 'Point', coordinates: [440100, 4474050, 657.25] } },
  ],
};

async function load(name: string, data: string | Uint8Array) {
  const res = await readFiles([{ name, data: typeof data === 'string' ? enc(data) : data }]);
  expect(res.errors).toEqual([]);
  return res.layers;
}

function toStore(layer: Awaited<ReturnType<typeof load>>[number]) {
  const store = new FeatureStore();
  const info = store.addLayer({ name: layer.name, source: layer.source, features: layer.features, fields: layer.fields });
  return { store, info };
}

function close(a: number[], b: number[], eps = 1e-6) {
  expect(a.length).toBe(b.length);
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, -Math.log10(eps)));
}

describe('GeoJSON', () => {
  it('lee el CRS declarado, reproyecta a WGS84 y conserva la Z', async () => {
    const [layer] = await load('red.geojson', JSON.stringify(UTM_FC));
    expect(layer!.source.crs).toBe('EPSG:25830');
    expect(layer!.source.hasZ).toBe(true);
    const c = (layer!.features[0]!.geometry as { coordinates: number[][] }).coordinates[0]!;
    expect(c[0]).toBeCloseTo(-3.7072, 3);
    expect(c[1]).toBeCloseTo(40.4145, 3);
    expect(c[2]).toBe(655.5);
  });

  it('ida y vuelta en el CRS original', async () => {
    const [layer] = await load('red.geojson', JSON.stringify(UTM_FC));
    const { store, info } = toStore(layer!);
    const out = await writeLayer(info, store.getFeatures(info.id));
    expect(out.fileName).toBe('red.geojson');
    const fc = JSON.parse(new TextDecoder().decode(out.data));
    expect(fc.crs.properties.name).toBe('urn:ogc:def:crs:EPSG::25830');
    close(fc.features[0].geometry.coordinates[0], [440000, 4474000, 655.5], 1e-3);
    expect(fc.features[0].id).toBe(1);
  });

  it('deduce UTM 30N si no hay CRS', async () => {
    const { crs, ...noCrs } = UTM_FC;
    void crs;
    const [layer] = await load('sin_crs.geojson', JSON.stringify(noCrs));
    expect(layer!.source.crs).toBe('EPSG:25830');
    expect(layer!.source.crsGuessed).toBe(true);
    expect(layer!.warnings[0]).toMatch(/supuesto/);
  });

  it('exporta solo los cambios con el atributo _cambio', async () => {
    const [layer] = await load('red.geojson', JSON.stringify(UTM_FC));
    const { store, info } = toStore(layer!);
    const [a, b] = store.getFeatures(info.id);
    store.transact('x', (tx) => {
      tx.setProperties(info.id, a!.id, { diametro: 400 });
      tx.delete(info.id, b!.id);
      tx.add(info.id, { type: 'Point', coordinates: [-3.7, 40.42] }, { nombre: 'Nueva' });
    });
    const out = await writeLayer(info, store.getFeatures(info.id, { includeDeleted: true }), { scope: 'changes', format: 'geojson' });
    expect(out.fileName).toBe('red_cambios.geojson');
    const fc = JSON.parse(new TextDecoder().decode(out.data));
    expect(fc.features.map((f: { properties: { _cambio: string } }) => f.properties._cambio).sort()).toEqual(['borrado', 'modificado', 'nuevo']);
    // La entidad nueva sin Z recibe la Z por defecto al ser una capa 3D
    const nueva = fc.features.find((f: { properties: { _cambio: string } }) => f.properties._cambio === 'nuevo');
    expect(nueva.geometry.coordinates).toHaveLength(3);
  });
});

describe('Shapefile', () => {
  async function roundtrip(features: EditorFeature[], fields: LayerInfo['fields'], crs = 'EPSG:25830', hasZ = true) {
    const store = new FeatureStore();
    const info = store.addLayer({
      name: 'prueba',
      source: { format: 'shapefile', fileName: 'prueba', crs, hasZ },
      features: features.map((f) => ({ geometry: f.geometry, properties: f.properties })),
      fields,
    });
    const out = await writeLayer(info, store.getFeatures(info.id));
    expect(out.fileName).toBe('prueba.zip');
    const res = await readFiles([{ name: out.fileName, data: out.data }]);
    expect(res.errors).toEqual([]);
    return { out, layers: res.layers };
  }

  const wgs = (g: EditorFeature['geometry']) => transformGeometry(g!, 'EPSG:25830', 'EPSG:4326');

  it('líneas 3D con atributos, acentos y CRS', async () => {
    const { layers, out } = await roundtrip(
      [
        { id: 'a', status: 'original', properties: { nombre: 'Calle Mayor ñ', longitud_total: 12.5, carriles: 2, activa: true, fecha: '2024-05-01' }, geometry: wgs({ type: 'LineString', coordinates: [[440000, 4474000, 650], [440100, 4474100, 651.5]] }) },
        { id: 'b', status: 'original', properties: { nombre: null, longitud_total: null, carriles: null, activa: null, fecha: null }, geometry: wgs({ type: 'MultiLineString', coordinates: [[[0 + 440000, 4474000, 1], [440010, 4474010, 2]], [[440020, 4474020, 3], [440030, 4474030, 4]]] }) },
      ],
      [
        { name: 'nombre', type: 'string' },
        { name: 'longitud_total', type: 'number' },
        { name: 'carriles', type: 'integer' },
        { name: 'activa', type: 'boolean' },
        { name: 'fecha', type: 'date' },
      ],
    );
    expect(out.warnings.join()).toMatch(/longitud_total → longitud_t/);
    const l = layers[0]!;
    expect(l.source.crs).toBe('EPSG:25830');
    expect(l.source.hasZ).toBe(true);
    expect(l.source.encoding).toBe('utf-8');
    expect(l.fields!.map((f) => f.type)).toEqual(['string', 'number', 'integer', 'boolean', 'date']);
    expect(l.features[0]!.properties).toEqual({ nombre: 'Calle Mayor ñ', longitud_t: 12.5, carriles: 2, activa: true, fecha: '2024-05-01' });
    expect(l.features[1]!.properties['nombre']).toBe('');
    const back = transformGeometry(l.features[0]!.geometry!, 'EPSG:4326', 'EPSG:25830') as { coordinates: number[][] };
    close(back.coordinates[1]!, [440100, 4474100, 651.5], 1e-3);
    expect(l.features[1]!.geometry!.type).toBe('MultiLineString');
  });

  it('polígonos con hueco conservan la topología y la orientación', async () => {
    const outer = [[440000, 4474000, 10], [440100, 4474000, 10], [440100, 4474100, 10], [440000, 4474100, 10], [440000, 4474000, 10]];
    const hole = [[440040, 4474040, 10], [440040, 4474060, 10], [440060, 4474060, 10], [440060, 4474040, 10], [440040, 4474040, 10]];
    const { layers } = await roundtrip([{ id: 'p', status: 'original', properties: { uso: 'parque' }, geometry: wgs({ type: 'Polygon', coordinates: [outer, hole] }) }], [{ name: 'uso', type: 'string' }]);
    const g = layers[0]!.features[0]!.geometry as { type: string; coordinates: number[][][] };
    expect(g.type).toBe('Polygon');
    expect(g.coordinates).toHaveLength(2);
  });

  it('capa mixta: un Shapefile por tipo de geometría', async () => {
    const { layers, out } = await roundtrip(
      [
        { id: 'a', status: 'original', properties: {}, geometry: { type: 'Point', coordinates: [-3.7, 40.4] } },
        { id: 'b', status: 'original', properties: {}, geometry: { type: 'LineString', coordinates: [[-3.7, 40.4], [-3.6, 40.5]] } },
      ],
      [],
      'EPSG:4326',
      false,
    );
    expect(out.warnings.join()).toMatch(/un Shapefile por tipo/);
    expect(layers.map((l) => l.name).sort()).toEqual(['prueba_lineas', 'prueba_puntos']);
  });

  it('lee DBF en Windows-1252 sin .cpg', async () => {
    const { out } = await roundtrip([{ id: 'a', status: 'original', properties: { n: 'x' }, geometry: { type: 'Point', coordinates: [-3.7, 40.4] } }], [{ name: 'n', type: 'string' }], 'EPSG:4326', false);
    const zip = await JSZip.loadAsync(out.data);
    const shp = await zip.file('prueba.shp')!.async('uint8array');
    const dbf = await zip.file('prueba.dbf')!.async('uint8array');
    // Sustituir el valor por "ñ" en Windows-1252 (0xF1)
    const headerLength = new DataView(dbf.buffer).getUint16(8, true);
    dbf[headerLength + 1] = 0xf1;
    const res = await readFiles([
      { name: 'x.shp', data: shp },
      { name: 'x.dbf', data: dbf },
    ]);
    expect(res.layers[0]!.source.encoding).toBe('windows-1252');
    expect(res.layers[0]!.features[0]!.properties['n']).toBe('ñ');
  });
});

describe('GeoPackage', () => {
  it('ida y vuelta con Z, CRS, tipos y fid', async () => {
    const [layer] = await load('red.geojson', JSON.stringify(UTM_FC));
    const { store, info } = toStore(layer!);
    const out = await writeLayer(info, store.getFeatures(info.id), { format: 'gpkg' });
    expect(out.fileName).toBe('red.gpkg');
    const [back] = await load('red.gpkg', out.data);
    expect(back!.source.format).toBe('gpkg');
    expect(back!.source.crs).toBe('EPSG:25830');
    expect(back!.source.hasZ).toBe(true);
    expect(back!.features.map((f) => f.id)).toEqual([1, 2]);
    expect(back!.features[0]!.properties).toEqual({ nombre: 'Tubería Ñandú', diametro: 300, material: 'fundición', activa: true });
    const c = (back!.features[0]!.geometry as { coordinates: number[][] }).coordinates[1]!;
    expect(c[2]).toBe(657.25);
  });
});

describe('FlatGeobuf', () => {
  it('ida y vuelta con Z y CRS', async () => {
    const [layer] = await load('red.geojson', JSON.stringify(UTM_FC));
    const { store, info } = toStore(layer!);
    const out = await writeLayer(info, store.getFeatures(info.id), { format: 'flatgeobuf' });
    const [back] = await load('red.fgb', out.data);
    expect(back!.source.crs).toBe('EPSG:25830');
    expect(back!.source.hasZ).toBe(true);
    const c = (back!.features[0]!.geometry as { coordinates: number[][] }).coordinates[0]!;
    expect(c[2]).toBe(655.5);
    expect(back!.features[0]!.properties['nombre']).toBe('Tubería Ñandú');
  });
});

describe('KML y GPX', () => {
  it('KML: ida y vuelta con altitud y atributos', async () => {
    const [layer] = await load('red.geojson', JSON.stringify(UTM_FC));
    const { store, info } = toStore(layer!);
    const out = await writeLayer(info, store.getFeatures(info.id), { format: 'kml', crs: 'EPSG:25830' });
    expect(out.warnings.join()).toMatch(/WGS84/);
    const [back] = await load('red.kml', out.data);
    expect(back!.source.hasZ).toBe(true);
    expect(back!.features[0]!.properties['nombre']).toBe('Tubería Ñandú');
    expect(back!.features[0]!.properties['diametro']).toBe('300');
  });

  it('GPX: puntos y tracks con elevación', async () => {
    const gpx = `<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
      <wpt lat="40.4" lon="-3.7"><ele>650</ele><name>Fuente</name></wpt>
      <trk><name>Ruta</name><trkseg><trkpt lat="40.4" lon="-3.7"><ele>650</ele></trkpt><trkpt lat="40.41" lon="-3.71"><ele>660</ele></trkpt></trkseg></trk></gpx>`;
    const [layer] = await load('ruta.gpx', gpx);
    expect(layer!.features).toHaveLength(2);
    expect(layer!.source.hasZ).toBe(true);
    const { store, info } = toStore(layer!);
    const out = await writeLayer(info, store.getFeatures(info.id));
    const text = new TextDecoder().decode(out.data);
    expect(text).toContain('<ele>660</ele>');
    expect(text).toContain('<name>Fuente</name>');
  });
});

describe('ZIP', () => {
  it('descomprime y agrupa los componentes del Shapefile', async () => {
    const [layer] = await load('red.geojson', JSON.stringify(UTM_FC));
    const { store, info } = toStore(layer!);
    const shpZip = await writeLayer({ ...info, geometryKind: 'LineString' }, store.getFeatures(info.id).slice(0, 1), { format: 'shapefile' });
    const outer = new JSZip();
    outer.file('datos/red.zip', shpZip.data);
    outer.file('__MACOSX/._red.shp', 'basura');
    const res = await readFiles([{ name: 'paquete.zip', data: await outer.generateAsync({ type: 'uint8array' }) }]);
    expect(res.errors).toEqual([]);
    expect(res.layers).toHaveLength(1);
    expect(res.layers[0]!.source.crs).toBe('EPSG:25830');
  });
});
