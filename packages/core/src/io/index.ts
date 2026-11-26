import type { Feature, FeatureCollection, Geometry, Position } from 'geojson';
import JSZip from 'jszip';
import { geojson as fgb } from 'flatgeobuf';
import { forEachCoord, hasZ as geomHasZ, mapCoords } from '../geom/coords.js';
import { crsFromWkt, epsgNumber, guessCrs, normalizeCrsCode, resolveCrs, transformGeometry, wktForCrs } from '../crs/crs.js';
import type { EditorFeature, ExportFormat, FieldDef, LayerInfo, LayerSource } from '../types.js';
import { inferFields } from '../store/store.js';
import { GDAL_EXTENSIONS, GDAL_WRITE_DRIVERS, readWithGdal, writeWithGdal } from './gdal.js';
import { readGeoPackage, writeGeoPackage } from './gpkg.js';
import { readShapefile, writeShapefile } from './shapefile.js';
import {
  baseName,
  extension,
  toBytes,
  UnsupportedFormatError,
  type ExportOptions,
  type ExportResult,
  type ImportedFeature,
  type ImportedLayer,
  type InputFile,
  type IoConfig,
  type WriterInput,
} from './types.js';
import { readGpx, readKml, writeGpx, writeKml } from './xml.js';

export * from './types.js';
export { setXmlParser } from './xml.js';
export { configureSqlJs } from './gpkg.js';

const SHP_PARTS = ['shp', 'dbf', 'shx', 'prj', 'cpg', 'qpj', 'sbn', 'sbx', 'xml'];

export const SUPPORTED_EXTENSIONS = ['geojson', 'json', 'shp', 'zip', 'kml', 'kmz', 'gpx', 'gpkg', 'fgb', ...GDAL_EXTENSIONS];

export const EXPORT_FORMATS: Array<{ id: ExportFormat | 'dxf' | 'gml' | 'csv'; name: string; supportsCrs: boolean }> = [
  { id: 'geojson', name: 'GeoJSON', supportsCrs: true },
  { id: 'shapefile', name: 'Shapefile (.zip)', supportsCrs: true },
  { id: 'gpkg', name: 'GeoPackage', supportsCrs: true },
  { id: 'flatgeobuf', name: 'FlatGeobuf', supportsCrs: true },
  { id: 'kml', name: 'KML', supportsCrs: false },
  { id: 'gpx', name: 'GPX', supportsCrs: false },
  { id: 'dxf', name: 'DXF (GDAL)', supportsCrs: true },
  { id: 'gml', name: 'GML (GDAL)', supportsCrs: true },
  { id: 'csv', name: 'CSV con WKT (GDAL)', supportsCrs: true },
];

export interface ReadResult {
  layers: ImportedLayer[];
  errors: Array<{ file: string; message: string }>;
}

/**
 * Lee un conjunto de ficheros (soltados o seleccionados). Agrupa los componentes de Shapefile,
 * descomprime ZIP/KMZ y reproyecta todo a WGS84 conservando la Z.
 */
export async function readFiles(input: InputFile[], config?: IoConfig): Promise<ReadResult> {
  const files = await expandArchives(input);
  const layers: ImportedLayer[] = [];
  const errors: ReadResult['errors'] = [];

  // Agrupar Shapefile por nombre base
  const shpGroups = new Map<string, Map<string, InputFile>>();
  const rest: InputFile[] = [];
  for (const f of files) {
    const ext = extension(f.name);
    if (SHP_PARTS.includes(ext)) {
      const key = f.name.replace(/\.[^.]+$/, '').toLowerCase();
      const g = shpGroups.get(key) ?? new Map<string, InputFile>();
      g.set(ext, f);
      shpGroups.set(key, g);
    } else rest.push(f);
  }
  for (const [, group] of shpGroups) {
    const shp = group.get('shp');
    if (!shp) {
      // .dbf suelto: tabla sin geometría
      const dbf = group.get('dbf');
      if (dbf) errors.push({ file: dbf.name, message: 'Falta el fichero .shp correspondiente.' });
      continue;
    }
    try {
      layers.push(readShpGroup(shp, group));
    } catch (err) {
      errors.push({ file: shp.name, message: msg(err) });
    }
  }

  for (const f of rest) {
    try {
      layers.push(...(await readSingle(f, config)));
    } catch (err) {
      errors.push({ file: f.name, message: msg(err) });
    }
  }
  return { layers, errors };
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const text = (f: InputFile) => new TextDecoder().decode(toBytes(f.data));

async function expandArchives(input: InputFile[], depth = 0): Promise<InputFile[]> {
  const out: InputFile[] = [];
  for (const f of input) {
    const ext = extension(f.name);
    if ((ext === 'zip' || ext === 'kmz') && depth < 3) {
      const zip = await JSZip.loadAsync(toBytes(f.data));
      const inner: InputFile[] = [];
      for (const entry of Object.values(zip.files)) {
        if (entry.dir || /(^|\/)__MACOSX\//.test(entry.name) || /(^|\/)\./.test(entry.name)) continue;
        // Los .gdb son carpetas: se pasan completos a GDAL más abajo
        inner.push({ name: entry.name, data: await entry.async('uint8array') });
      }
      if (inner.some((i) => /\.gdb\//i.test(i.name))) {
        out.push(f); // File Geodatabase comprimida: GDAL la abre como ZIP
        continue;
      }
      out.push(...(await expandArchives(inner, depth + 1)));
    } else out.push(f);
  }
  return out;
}

function readShpGroup(shp: InputFile, group: Map<string, InputFile>): ImportedLayer {
  const prj = group.get('prj') ? text(group.get('prj')!) : undefined;
  const cpg = group.get('cpg') ? text(group.get('cpg')!) : undefined;
  const res = readShapefile({
    shp: toBytes(shp.data),
    ...(group.get('dbf') ? { dbf: toBytes(group.get('dbf')!.data) } : {}),
    ...(prj ? { prj } : {}),
    ...(cpg ? { cpg } : {}),
  });
  return finalize(
    {
      name: baseName(shp.name),
      features: res.features,
      fields: res.fields,
      warnings: res.warnings,
      source: { format: 'shapefile', fileName: baseName(shp.name), crs: '', hasZ: res.hasZ, encoding: res.encoding, ...(prj ? { crsWkt: prj } : {}) },
    },
    prj ?? null,
  );
}

async function readSingle(f: InputFile, config?: IoConfig): Promise<ImportedLayer[]> {
  const ext = extension(f.name);
  const name = baseName(f.name);
  switch (ext) {
    case 'geojson':
    case 'json': {
      const parsed = JSON.parse(text(f)) as FeatureCollection | Feature | Geometry;
      return [readGeoJsonObject(parsed, name, f.name)];
    }
    case 'kml': {
      const features = readKml(text(f));
      return [finalize({ name, features, warnings: [], source: { format: 'kml', fileName: name, crs: 'EPSG:4326', hasZ: false } }, 'EPSG:4326')];
    }
    case 'gpx': {
      const features = readGpx(text(f));
      return [finalize({ name, features, warnings: [], source: { format: 'gpx', fileName: name, crs: 'EPSG:4326', hasZ: false } }, 'EPSG:4326')];
    }
    case 'gpkg': {
      const tables = await readGeoPackage(toBytes(f.data), config);
      if (!tables.length) throw new Error('El GeoPackage no contiene tablas de entidades.');
      return tables.map((t) =>
        finalize(
          {
            name: tables.length > 1 ? `${name} · ${t.table}` : name,
            features: t.features,
            fields: t.fields,
            warnings: [],
            source: { format: 'gpkg', fileName: name, crs: '', hasZ: t.hasZ, ...(t.srsWkt ? { crsWkt: t.srsWkt } : {}), formatOptions: { table: t.table } },
          },
          t.srsCode ?? t.srsWkt,
        ),
      );
    }
    case 'fgb': {
      let crs: string | null = null;
      const features: ImportedFeature[] = [];
      for await (const feat of fgb.deserialize(toBytes(f.data), {
        headerMetaFn: (meta) => {
          if (meta.crs) crs = meta.crs.code > 0 ? `${meta.crs.org ?? 'EPSG'}:${meta.crs.code}` : meta.crs.wkt;
        },
      }) as AsyncGenerator<Feature>) {
        features.push({ geometry: feat.geometry ?? null, properties: { ...(feat.properties ?? {}) } });
      }
      return [finalize({ name, features, warnings: [], source: { format: 'flatgeobuf', fileName: name, crs: '', hasZ: false } }, crs)];
    }
    default: {
      if (!GDAL_EXTENSIONS.includes(ext) && ext !== 'zip') throw new UnsupportedFormatError(f.name);
      const res = await readWithGdal([f], config);
      return res.map((r) => {
        const layer = readGeoJsonObject(r.collection, res.length > 1 ? `${name} · ${r.name}` : name, f.name, r.crs ?? r.crsWkt);
        layer.source.format = 'gdal';
        layer.source.formatOptions = { driverExt: ext };
        if (r.crsWkt) layer.source.crsWkt = r.crsWkt;
        return layer;
      });
    }
  }
}

/** Convierte un objeto GeoJSON en capa. Admite el miembro `crs` (GeoJSON 2008) y deduce UTM si no lo hay. */
export function readGeoJsonObject(obj: FeatureCollection | Feature | Geometry, name: string, fileName?: string, crsOverride?: string | null): ImportedLayer {
  let features: ImportedFeature[];
  if (obj.type === 'FeatureCollection') {
    features = obj.features.map((f) => ({ geometry: f.geometry ?? null, properties: { ...(f.properties ?? {}) }, ...(f.id !== undefined ? { id: f.id } : {}) }));
  } else if (obj.type === 'Feature') {
    features = [{ geometry: obj.geometry ?? null, properties: { ...(obj.properties ?? {}) }, ...(obj.id !== undefined ? { id: obj.id } : {}) }];
  } else {
    features = [{ geometry: obj, properties: {} }];
  }
  const declared = (obj as { crs?: { properties?: { name?: string } } }).crs?.properties?.name;
  return finalize(
    { name, features, warnings: [], source: { format: 'geojson', ...(fileName ? { fileName: baseName(fileName) } : {}), crs: '', hasZ: false } },
    crsOverride ?? (declared ? normalizeCrsCode(declared) : null),
    !declared && !crsOverride,
  );
}

/** Resuelve el CRS, reproyecta a WGS84 y completa los metadatos de la capa. */
function finalize(layer: ImportedLayer, crsInput: string | null, allowGuess = true): ImportedLayer {
  let crs: string;
  if (crsInput) {
    crs = resolveCrs(crsInput);
    if (crs.startsWith('WKT:')) layer.warnings.push('CRS definido por WKT sin código EPSG reconocido.');
  } else if (allowGuess) {
    const sample: Position[] = [];
    for (const f of layer.features) {
      forEachCoord(f.geometry, (c) => {
        if (sample.length < 200) sample.push(c);
      });
      if (sample.length >= 200) break;
    }
    const g = guessCrs(sample);
    crs = g.crs;
    if (g.guessed) {
      layer.source.crsGuessed = true;
      layer.warnings.push(`El fichero no declara CRS; se ha supuesto ${crs}. Revísalo antes de exportar.`);
    }
  } else crs = 'EPSG:4326';

  const sourceCode = crs.startsWith('WKT:') ? (crsFromWkt(layer.source.crsWkt ?? '') ?? crs) : crs;
  layer.source.crs = sourceCode;
  let anyZ = layer.source.hasZ;
  for (const f of layer.features) {
    if (!f.geometry) continue;
    if (!anyZ && geomHasZ(f.geometry)) anyZ = true;
    f.geometry = transformGeometry(f.geometry, crs, 'EPSG:4326');
  }
  layer.source.hasZ = anyZ;
  if (!layer.fields) layer.fields = inferFields(layer.features.map((f) => f.properties));
  return layer;
}

// --- Exportación --------------------------------------------------------------------------

const CHANGE_LABEL = { new: 'nuevo', modified: 'modificado', deleted: 'borrado', original: '' } as const;

export async function writeLayer(layer: LayerInfo, allFeatures: readonly Readonly<EditorFeature>[], options: ExportOptions = {}, config?: IoConfig): Promise<ExportResult> {
  const warnings: string[] = [];
  const format = (options.format ?? (layer.source.format === 'memory' ? 'geojson' : layer.source.format)) as string;
  const scope = options.scope ?? 'all';
  const geographicOnly = format === 'kml' || format === 'gpx';
  let crs = normalizeCrsCode(options.crs ?? layer.source.crs ?? 'EPSG:4326');
  if (geographicOnly && crs !== 'EPSG:4326') {
    if (options.crs) warnings.push(`${format.toUpperCase()} siempre usa WGS84: se ignora ${crs}.`);
    crs = 'EPSG:4326';
  }
  const crsKey = resolveCrs(crs === layer.source.crs && layer.source.crsWkt && crs.startsWith('WKT:') ? layer.source.crsWkt : crs);

  const selected = allFeatures.filter((f) => (scope === 'all' ? f.status !== 'deleted' : f.status !== 'original'));
  const hasZ = layer.source.hasZ || selected.some((f) => geomHasZ(f.geometry));
  const features: EditorFeature[] = selected.map((f) => {
    let geometry = f.geometry;
    if (geometry && hasZ) geometry = mapCoords(geometry, (c) => (c.length > 2 ? c : [c[0]!, c[1]!, layer.defaultZ]));
    if (geometry) geometry = transformGeometry(geometry, 'EPSG:4326', crsKey);
    return { ...f, geometry, properties: { ...f.properties } };
  });
  const extra = scope === 'changes' ? { name: '_cambio', values: selected.map((f) => CHANGE_LABEL[f.status]) } : undefined;
  const base = sanitizeFileName(options.fileName ?? layer.source.fileName ?? layer.name);
  const input: WriterInput = { layer, features, fields: layer.fields, crs, hasZ, baseName: base };
  const suffix = scope === 'changes' ? '_cambios' : '';

  switch (format) {
    case 'geojson': {
      const json = toGeoJsonText(input, extra);
      return { fileName: `${base}${suffix}.geojson`, data: new TextEncoder().encode(json), mimeType: 'application/geo+json', warnings };
    }
    case 'shapefile': {
      const wkt = crs === layer.source.crs && layer.source.crsWkt ? layer.source.crsWkt : wktForCrs(crs);
      const out = writeShapefile({ ...input, baseName: base + suffix }, wkt, extra);
      warnings.push(...out.warnings);
      const zip = new JSZip();
      for (const [n, d] of Object.entries(out.files)) zip.file(n, d);
      const data = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
      return { fileName: `${base}${suffix}.zip`, data, mimeType: 'application/zip', warnings };
    }
    case 'gpkg': {
      const wkt = crs === layer.source.crs && layer.source.crsWkt ? layer.source.crsWkt : wktForCrs(crs);
      const data = await writeGeoPackage(input, wkt, extra, config);
      return { fileName: `${base}${suffix}.gpkg`, data, mimeType: 'application/geopackage+sqlite3', warnings };
    }
    case 'flatgeobuf': {
      const fc = JSON.parse(toGeoJsonText(input, extra, false)) as FeatureCollection;
      if (fc.features.some((f) => !f.geometry)) {
        warnings.push('FlatGeobuf no admite entidades sin geometría: se omiten.');
        fc.features = fc.features.filter((f) => f.geometry);
      }
      const data = fgb.serialize(fc, epsgNumber(crs) ?? 0);
      return { fileName: `${base}${suffix}.fgb`, data, mimeType: 'application/octet-stream', warnings };
    }
    case 'kml': {
      const kml = writeKml(input, extra);
      return { fileName: `${base}${suffix}.kml`, data: new TextEncoder().encode(kml), mimeType: 'application/vnd.google-earth.kml+xml', warnings };
    }
    case 'gpx': {
      const gpx = writeGpx(input, warnings);
      return { fileName: `${base}${suffix}.gpx`, data: new TextEncoder().encode(gpx), mimeType: 'application/gpx+xml', warnings };
    }
    default: {
      const gdalFormat = format === 'gdal' ? String(layer.source.formatOptions?.['driverExt'] ?? '') : format;
      if (!GDAL_WRITE_DRIVERS[gdalFormat]) {
        warnings.push(`No se puede escribir ${gdalFormat || format}: se exporta como GeoPackage.`);
        return writeLayer(layer, allFeatures, { ...options, format: 'gpkg' }, config).then((r) => ({ ...r, warnings: [...warnings, ...r.warnings] }));
      }
      const res = await writeWithGdal(toGeoJsonText(input, extra), crs, gdalFormat, base + suffix, config);
      return { fileName: `${base}${suffix}.${res.ext}`, data: res.data, mimeType: res.mime, warnings };
    }
  }
}

function toGeoJsonText(input: WriterInput, extra?: { name: string; values: string[] }, withCrsMember = true): string {
  const fc: FeatureCollection<Geometry | null> & { crs?: unknown; name?: string } = {
    type: 'FeatureCollection',
    name: input.layer.name,
    ...(withCrsMember && input.crs !== 'EPSG:4326' ? { crs: { type: 'name', properties: { name: `urn:ogc:def:crs:${input.crs.replace(':', '::')}` } } } : {}),
    features: input.features.map((f, i) => ({
      type: 'Feature',
      ...(f.sourceId !== undefined ? { id: f.sourceId } : {}),
      properties: extra ? { ...f.properties, [extra.name]: extra.values[i] } : f.properties,
      geometry: f.geometry,
    })),
  };
  return JSON.stringify(fc);
}

function sanitizeFileName(s: string): string {
  return s.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'capa';
}

/** Metadatos de origen para capas creadas desde cero en el editor. */
export function memorySource(hasZ = false): LayerSource {
  return { format: 'memory', crs: 'EPSG:4326', hasZ };
}

export type { FieldDef };
