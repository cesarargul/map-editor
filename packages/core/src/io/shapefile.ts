import type { Geometry, Position } from 'geojson';
import { geometryFamily, linearParts, pointInRing, signedArea } from '../geom/coords.js';
import type { FieldDef } from '../types.js';
import type { ImportedFeature, WriterInput } from './types.js';

/**
 * Lector y escritor propio de Shapefile (.shp/.shx/.dbf/.prj/.cpg) con soporte completo de Z
 * (PointZ, MultiPointZ, PolyLineZ, PolygonZ). Las coordenadas se devuelven en el CRS del fichero.
 */

// --- Lectura -------------------------------------------------------------------------------

export interface ShapefileParts {
  shp: Uint8Array;
  dbf?: Uint8Array;
  prj?: string;
  cpg?: string;
}

export interface ShapefileReadResult {
  features: ImportedFeature[];
  fields: FieldDef[];
  hasZ: boolean;
  encoding: string;
  shapeType: number;
  warnings: string[];
}

export function readShapefile(parts: ShapefileParts): ShapefileReadResult {
  const warnings: string[] = [];
  const shp = new DataView(parts.shp.buffer, parts.shp.byteOffset, parts.shp.byteLength);
  if (shp.getInt32(0, false) !== 9994) throw new Error('El fichero .shp no es válido');
  const fileLength = shp.getInt32(24, false) * 2;
  const shapeType = shp.getInt32(32, true);
  const hasZ = [11, 13, 15, 18].includes(shapeType);

  const geometries: Array<Geometry | null> = [];
  let o = 100;
  const end = Math.min(fileLength, parts.shp.byteLength);
  while (o + 8 <= end) {
    const contentLength = shp.getInt32(o + 4, false) * 2;
    const start = o + 8;
    geometries.push(contentLength >= 4 ? readShape(shp, start, contentLength) : null);
    o = start + contentLength;
  }

  let rows: Array<Record<string, unknown>> = [];
  let fields: FieldDef[] = [];
  let encoding = 'utf-8';
  if (parts.dbf) {
    const dbf = readDbf(parts.dbf, parts.cpg);
    rows = dbf.rows;
    fields = dbf.fields;
    encoding = dbf.encoding;
    if (dbf.rows.length !== geometries.length) {
      warnings.push(`El .dbf tiene ${dbf.rows.length} registros y el .shp ${geometries.length} geometrías.`);
    }
  } else {
    warnings.push('Falta el fichero .dbf: la capa no tendrá atributos.');
  }

  const features: ImportedFeature[] = geometries.map((geometry, i) => ({ geometry, properties: rows[i] ?? {} }));
  return { features, fields, hasZ, encoding, shapeType, warnings };
}

function readShape(dv: DataView, o: number, length: number): Geometry | null {
  const type = dv.getInt32(o, true);
  const base = type % 10 === 1 && type !== 31 ? 'point' : type;
  const zType = [11, 13, 15, 18].includes(type);
  if (type === 0) return null;

  if (base === 'point') {
    const x = dv.getFloat64(o + 4, true);
    const y = dv.getFloat64(o + 12, true);
    if (type === 11) return { type: 'Point', coordinates: [x, y, dv.getFloat64(o + 20, true)] };
    return { type: 'Point', coordinates: [x, y] };
  }

  if (type === 8 || type === 18 || type === 28) {
    const n = dv.getInt32(o + 36, true);
    const pts: Position[] = [];
    let p = o + 40;
    for (let i = 0; i < n; i++, p += 16) pts.push([dv.getFloat64(p, true), dv.getFloat64(p + 8, true)]);
    if (zType) {
      let zp = o + 40 + n * 16 + 16;
      for (let i = 0; i < n; i++, zp += 8) if (zp + 8 <= o + length) pts[i]!.push(dv.getFloat64(zp, true));
    }
    return n === 1 ? { type: 'Point', coordinates: pts[0]! } : { type: 'MultiPoint', coordinates: pts };
  }

  if ([3, 5, 13, 15, 23, 25].includes(type)) {
    const numParts = dv.getInt32(o + 36, true);
    const numPoints = dv.getInt32(o + 40, true);
    const partsStart = o + 44;
    const pointsStart = partsStart + numParts * 4;
    const pts: Position[] = [];
    for (let i = 0, p = pointsStart; i < numPoints; i++, p += 16) pts.push([dv.getFloat64(p, true), dv.getFloat64(p + 8, true)]);
    if (zType) {
      let zp = pointsStart + numPoints * 16 + 16;
      for (let i = 0; i < numPoints; i++, zp += 8) pts[i]!.push(dv.getFloat64(zp, true));
    }
    const rings: Position[][] = [];
    for (let i = 0; i < numParts; i++) {
      const s = dv.getInt32(partsStart + i * 4, true);
      const e = i + 1 < numParts ? dv.getInt32(partsStart + (i + 1) * 4, true) : numPoints;
      rings.push(pts.slice(s, e));
    }
    if (type % 10 === 3) {
      return rings.length === 1 ? { type: 'LineString', coordinates: rings[0]! } : { type: 'MultiLineString', coordinates: rings };
    }
    return assemblePolygon(rings);
  }
  throw new Error(`Tipo de shape no soportado: ${type}`);
}

/** Agrupa anillos de Shapefile (exteriores horarios, huecos antihorarios) en (Multi)Polygon RFC 7946. */
function assemblePolygon(rings: Position[][]): Geometry {
  const outers: Position[][][] = [];
  const holes: Position[][] = [];
  for (const r of rings) {
    if (r.length < 4) continue;
    if (signedArea(r) < 0) outers.push([r.slice().reverse()]);
    else holes.push(r.slice().reverse());
  }
  for (const h of holes) {
    const owner = outers.find((poly) => pointInRing(h[0]!, poly[0]!));
    if (owner) owner.push(h);
    else outers.push([h.slice().reverse()]);
  }
  return outers.length === 1 ? { type: 'Polygon', coordinates: outers[0]! } : { type: 'MultiPolygon', coordinates: outers };
}

// --- DBF ----------------------------------------------------------------------------------

const LDID: Record<number, string> = {
  0x01: 'ibm437',
  0x02: 'ibm850',
  0x03: 'windows-1252',
  0x57: 'windows-1252',
  0x58: 'windows-1252',
  0x59: 'windows-1252',
  0x64: 'ibm852',
  0x65: 'ibm866',
  0xc8: 'windows-1250',
};

export function encodingFromCpg(cpg: string | undefined): string | null {
  if (!cpg) return null;
  const s = cpg.trim().toLowerCase().replace(/\s+/g, '');
  if (s === 'utf-8' || s === 'utf8' || s === '65001') return 'utf-8';
  const m = s.match(/(\d{3,5})$/);
  if (m) {
    const n = m[1]!;
    if (n === '88591' || n === '8859') return 'iso-8859-1';
    if (n.startsWith('8859')) return `iso-8859-${n.slice(4)}`;
    if (n.length === 4 && n.startsWith('12')) return `windows-${n}`;
  }
  if (s.startsWith('iso-8859') || s.startsWith('windows-')) return s;
  return null;
}

function decoderFor(enc: string): TextDecoder {
  try {
    return new TextDecoder(enc);
  } catch {
    return new TextDecoder('windows-1252');
  }
}

export function readDbf(bytes: Uint8Array, cpg?: string): { rows: Array<Record<string, unknown>>; fields: FieldDef[]; encoding: string } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const numRecords = dv.getUint32(4, true);
  const headerLength = dv.getUint16(8, true);
  const recordLength = dv.getUint16(10, true);
  const ldid = dv.getUint8(29);

  let encoding = encodingFromCpg(cpg) ?? LDID[ldid] ?? null;
  if (!encoding) {
    // Sin .cpg ni LDID: probar UTF-8 estricto y, si falla, Windows-1252 (lo habitual en datos españoles antiguos).
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(headerLength));
      encoding = 'utf-8';
    } catch {
      encoding = 'windows-1252';
    }
  }
  const dec = decoderFor(encoding);

  interface Desc {
    name: string;
    type: string;
    length: number;
    decimals: number;
    offset: number;
  }
  const descs: Desc[] = [];
  let off = 1;
  for (let p = 32; p + 32 <= headerLength && bytes[p] !== 0x0d; p += 32) {
    const raw = bytes.subarray(p, p + 11);
    const nul = raw.indexOf(0);
    const name = dec.decode(raw.subarray(0, nul < 0 ? 11 : nul)).trim();
    const type = String.fromCharCode(bytes[p + 11]!);
    const length = bytes[p + 16]!;
    const decimals = bytes[p + 17]!;
    descs.push({ name, type, length, decimals, offset: off });
    off += length;
  }

  const fields: FieldDef[] = descs.map((d) => ({
    name: d.name,
    type:
      d.type === 'N' || d.type === 'F'
        ? d.decimals > 0 || d.type === 'F'
          ? 'number'
          : 'integer'
        : d.type === 'L'
          ? 'boolean'
          : d.type === 'D'
            ? 'date'
            : 'string',
  }));

  const rows: Array<Record<string, unknown>> = [];
  for (let r = 0; r < numRecords; r++) {
    const start = headerLength + r * recordLength;
    if (start + recordLength > bytes.byteLength) break;
    const row: Record<string, unknown> = {};
    for (const d of descs) {
      const raw = bytes.subarray(start + d.offset, start + d.offset + d.length);
      const text = dec.decode(raw).replace(/\0/g, '').trim();
      switch (d.type) {
        case 'N':
        case 'F': {
          const v = text === '' || /^\*+$/.test(text) ? null : Number(text);
          row[d.name] = v !== null && Number.isFinite(v) ? v : null;
          break;
        }
        case 'L':
          row[d.name] = /^[TtYy]$/.test(text) ? true : /^[FfNn]$/.test(text) ? false : null;
          break;
        case 'D':
          row[d.name] = /^\d{8}$/.test(text) ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}` : null;
          break;
        default:
          row[d.name] = text;
      }
    }
    rows.push(row);
    // Los registros marcados como borrados (0x2A) se respetan para mantener la correspondencia con el .shp
  }
  return { rows, fields, encoding };
}

// --- Escritura ----------------------------------------------------------------------------

export interface ShapefileOutput {
  /** Ficheros por nombre (`base.shp`, `base.dbf`…). */
  files: Record<string, Uint8Array | string>;
  warnings: string[];
}

const FAMILY_SUFFIX = { Point: 'puntos', LineString: 'lineas', Polygon: 'poligonos' } as const;

/**
 * Escribe la capa como uno o varios Shapefile (uno por tipo de geometría si la capa es mixta).
 * `prj` es el WKT del CRS de salida.
 */
export function writeShapefile(input: WriterInput, prj: string | null, extraField?: { name: string; values: string[] }): ShapefileOutput {
  const warnings: string[] = [];
  const files: Record<string, Uint8Array | string> = {};
  const groups = new Map<'Point' | 'LineString' | 'Polygon' | null, number[]>();
  input.features.forEach((f, i) => {
    const fam = geometryFamily(f.geometry);
    const list = groups.get(fam) ?? [];
    list.push(i);
    groups.set(fam, list);
  });
  const nulls = groups.get(null) ?? [];
  groups.delete(null);
  if (groups.size === 0 && nulls.length) groups.set('Point', []);
  const multi = groups.size > 1;
  if (multi) warnings.push('La capa mezcla tipos de geometría: se exporta un Shapefile por tipo.');

  const { names, renamed } = dbfFieldNames(input.fields.map((f) => f.name).concat(extraField ? [extraField.name] : []));
  if (renamed.length) warnings.push(`Nombres de campo recortados a 10 caracteres: ${renamed.join(', ')}`);

  let first = true;
  for (const [family, indexes] of groups) {
    const idx = first ? [...indexes, ...nulls] : indexes;
    first = false;
    const base = multi ? `${input.baseName}_${FAMILY_SUFFIX[family!]}` : input.baseName;
    const feats = idx.map((i) => input.features[i]!);
    const { shp, shx } = writeShp(family!, feats.map((f) => f.geometry), input.hasZ);
    files[`${base}.shp`] = shp;
    files[`${base}.shx`] = shx;
    const rows = idx.map((i) => {
      const row = input.features[i]!.properties;
      return extraField ? { ...row, [extraField.name]: extraField.values[i] } : row;
    });
    const fields = extraField ? [...input.fields, { name: extraField.name, type: 'string' as const }] : input.fields;
    files[`${base}.dbf`] = writeDbf(fields, names, rows, warnings);
    files[`${base}.cpg`] = 'UTF-8';
    if (prj) files[`${base}.prj`] = prj;
  }
  if (!prj) warnings.push('No se conoce el WKT del CRS de salida: el Shapefile se exporta sin .prj.');
  return { files, warnings };
}

function writeShp(family: 'Point' | 'LineString' | 'Polygon', geoms: Array<Geometry | null>, hasZ: boolean) {
  const anyMultiPoint = family === 'Point' && geoms.some((g) => g?.type === 'MultiPoint');
  const shapeType =
    family === 'Point' ? (anyMultiPoint ? (hasZ ? 18 : 8) : hasZ ? 11 : 1) : family === 'LineString' ? (hasZ ? 13 : 3) : hasZ ? 15 : 5;

  const records: Uint8Array[] = geoms.map((g) => encodeShape(shapeType, g));
  const shpLength = 100 + records.reduce((s, r) => s + 8 + r.byteLength, 0);
  const shp = new Uint8Array(shpLength);
  const shx = new Uint8Array(100 + records.length * 8);
  const sdv = new DataView(shp.buffer);
  const xdv = new DataView(shx.buffer);

  const box = [Infinity, Infinity, -Infinity, -Infinity, Infinity, -Infinity];
  for (const g of geoms) {
    if (!g) continue;
    for (const c of allCoords(g)) {
      box[0] = Math.min(box[0]!, c[0]!);
      box[1] = Math.min(box[1]!, c[1]!);
      box[2] = Math.max(box[2]!, c[0]!);
      box[3] = Math.max(box[3]!, c[1]!);
      box[4] = Math.min(box[4]!, c[2] ?? 0);
      box[5] = Math.max(box[5]!, c[2] ?? 0);
    }
  }
  const finite = box.map((v) => (Number.isFinite(v) ? v : 0));

  for (const [dv, len] of [
    [sdv, shpLength],
    [xdv, shx.byteLength],
  ] as const) {
    dv.setInt32(0, 9994, false);
    dv.setInt32(24, len / 2, false);
    dv.setInt32(28, 1000, true);
    dv.setInt32(32, shapeType, true);
    dv.setFloat64(36, finite[0]!, true);
    dv.setFloat64(44, finite[1]!, true);
    dv.setFloat64(52, finite[2]!, true);
    dv.setFloat64(60, finite[3]!, true);
    dv.setFloat64(68, finite[4]!, true);
    dv.setFloat64(76, finite[5]!, true);
  }

  let o = 100;
  records.forEach((rec, i) => {
    sdv.setInt32(o, i + 1, false);
    sdv.setInt32(o + 4, rec.byteLength / 2, false);
    shp.set(rec, o + 8);
    xdv.setInt32(100 + i * 8, o / 2, false);
    xdv.setInt32(100 + i * 8 + 4, rec.byteLength / 2, false);
    o += 8 + rec.byteLength;
  });
  return { shp, shx };
}

function allCoords(g: Geometry): Position[] {
  switch (g.type) {
    case 'Point':
      return [g.coordinates];
    case 'MultiPoint':
    case 'LineString':
      return g.coordinates;
    case 'MultiLineString':
    case 'Polygon':
      return g.coordinates.flat();
    case 'MultiPolygon':
      return g.coordinates.flat(2);
    default:
      return [];
  }
}

function encodeShape(shapeType: number, g: Geometry | null): Uint8Array {
  if (!g) {
    const b = new Uint8Array(4);
    return b; // tipo 0 = null shape
  }
  const z = [11, 13, 15, 18].includes(shapeType);

  if (shapeType === 1 || shapeType === 11) {
    const c = g.type === 'Point' ? g.coordinates : (g as { coordinates: Position[] }).coordinates[0]!;
    const b = new Uint8Array(z ? 36 : 20);
    const dv = new DataView(b.buffer);
    dv.setInt32(0, shapeType, true);
    dv.setFloat64(4, c[0]!, true);
    dv.setFloat64(12, c[1]!, true);
    if (z) {
      dv.setFloat64(20, c[2] ?? 0, true);
      dv.setFloat64(28, 0, true); // M
    }
    return b;
  }

  if (shapeType === 8 || shapeType === 18) {
    const pts = g.type === 'Point' ? [g.coordinates] : (g as { coordinates: Position[] }).coordinates;
    const n = pts.length;
    const b = new Uint8Array(40 + n * 16 + (z ? 16 + n * 8 : 0));
    const dv = new DataView(b.buffer);
    dv.setInt32(0, shapeType, true);
    writeBox(dv, 4, pts);
    dv.setInt32(36, n, true);
    pts.forEach((c, i) => {
      dv.setFloat64(40 + i * 16, c[0]!, true);
      dv.setFloat64(48 + i * 16, c[1]!, true);
    });
    if (z) writeZ(dv, 40 + n * 16, pts);
    return b;
  }

  // PolyLine / Polygon
  let parts: Position[][];
  if (shapeType === 5 || shapeType === 15) {
    parts = [];
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    for (const poly of polys) {
      poly.forEach((ring, ri) => {
        const cw = signedArea(ring) < 0;
        // Shapefile: exterior en sentido horario, huecos antihorarios.
        parts.push(ri === 0 ? (cw ? ring : ring.slice().reverse()) : cw ? ring.slice().reverse() : ring);
      });
    }
  } else {
    parts = linearParts(g).map((p) => p.coords);
  }
  const pts = parts.flat();
  const n = pts.length;
  const np = parts.length;
  const b = new Uint8Array(44 + np * 4 + n * 16 + (z ? 16 + n * 8 : 0));
  const dv = new DataView(b.buffer);
  dv.setInt32(0, shapeType, true);
  writeBox(dv, 4, pts);
  dv.setInt32(36, np, true);
  dv.setInt32(40, n, true);
  let start = 0;
  parts.forEach((p, i) => {
    dv.setInt32(44 + i * 4, start, true);
    start += p.length;
  });
  const ptsStart = 44 + np * 4;
  pts.forEach((c, i) => {
    dv.setFloat64(ptsStart + i * 16, c[0]!, true);
    dv.setFloat64(ptsStart + i * 16 + 8, c[1]!, true);
  });
  if (z) writeZ(dv, ptsStart + n * 16, pts);
  return b;
}

function writeBox(dv: DataView, o: number, pts: Position[]) {
  const xs = pts.map((c) => c[0]!);
  const ys = pts.map((c) => c[1]!);
  dv.setFloat64(o, Math.min(...xs), true);
  dv.setFloat64(o + 8, Math.min(...ys), true);
  dv.setFloat64(o + 16, Math.max(...xs), true);
  dv.setFloat64(o + 24, Math.max(...ys), true);
}

function writeZ(dv: DataView, o: number, pts: Position[]) {
  const zs = pts.map((c) => c[2] ?? 0);
  dv.setFloat64(o, Math.min(...zs), true);
  dv.setFloat64(o + 8, Math.max(...zs), true);
  zs.forEach((z, i) => dv.setFloat64(o + 16 + i * 8, z, true));
}

/** Nombres de campo válidos para DBF (≤10 bytes, únicos). */
export function dbfFieldNames(names: string[]): { names: Map<string, string>; renamed: string[] } {
  const out = new Map<string, string>();
  const used = new Set<string>();
  const renamed: string[] = [];
  const enc = new TextEncoder();
  for (const name of names) {
    let base = name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9_]/g, '_');
    if (!base) base = 'campo';
    while (enc.encode(base).byteLength > 10) base = base.slice(0, -1);
    let candidate = base;
    let k = 1;
    while (used.has(candidate.toUpperCase())) {
      const suffix = `_${k++}`;
      candidate = base.slice(0, 10 - suffix.length) + suffix;
    }
    used.add(candidate.toUpperCase());
    out.set(name, candidate);
    if (candidate !== name) renamed.push(`${name} → ${candidate}`);
  }
  return { names: out, renamed };
}

function truncateUtf8(s: string, maxBytes: number): Uint8Array {
  const enc = new TextEncoder();
  let bytes = enc.encode(s);
  if (bytes.byteLength <= maxBytes) return bytes;
  let cut = s;
  while (bytes.byteLength > maxBytes) {
    cut = cut.slice(0, -1);
    bytes = enc.encode(cut);
  }
  return bytes;
}

export function writeDbf(fields: FieldDef[], names: Map<string, string>, rows: Array<Record<string, unknown>>, warnings: string[]): Uint8Array {
  const enc = new TextEncoder();
  interface Desc {
    field: FieldDef;
    name: string;
    type: string;
    length: number;
    decimals: number;
  }
  const descs: Desc[] = fields.map((field) => {
    const name = names.get(field.name) ?? field.name.slice(0, 10);
    switch (field.type) {
      case 'integer': {
        const maxLen = Math.max(1, ...rows.map((r) => (typeof r[field.name] === 'number' ? String(Math.trunc(r[field.name] as number)).length : 1)));
        return { field, name, type: 'N', length: Math.min(Math.max(maxLen, 10), 20), decimals: 0 };
      }
      case 'number':
        return { field, name, type: 'N', length: 24, decimals: 15 };
      case 'boolean':
        return { field, name, type: 'L', length: 1, decimals: 0 };
      case 'date':
        return { field, name, type: 'D', length: 8, decimals: 0 };
      default: {
        const maxLen = Math.max(1, ...rows.map((r) => (r[field.name] == null ? 0 : enc.encode(String(r[field.name])).byteLength)));
        if (maxLen > 254) warnings.push(`El campo "${field.name}" tiene textos de más de 254 bytes: se recortan.`);
        return { field, name, type: 'C', length: Math.min(maxLen, 254), decimals: 0 };
      }
    }
  });

  const headerLength = 32 + descs.length * 32 + 1;
  const recordLength = 1 + descs.reduce((s, d) => s + d.length, 0);
  const out = new Uint8Array(headerLength + rows.length * recordLength + 1);
  const dv = new DataView(out.buffer);
  const now = new Date();
  out[0] = 0x03;
  out[1] = now.getFullYear() - 1900;
  out[2] = now.getMonth() + 1;
  out[3] = now.getDate();
  dv.setUint32(4, rows.length, true);
  dv.setUint16(8, headerLength, true);
  dv.setUint16(10, recordLength, true);
  out[29] = 0x00; // codificación indicada en el .cpg (UTF-8)

  descs.forEach((d, i) => {
    const p = 32 + i * 32;
    out.set(enc.encode(d.name).subarray(0, 10), p);
    out[p + 11] = d.type.charCodeAt(0);
    out[p + 16] = d.length;
    out[p + 17] = d.decimals;
  });
  out[headerLength - 1] = 0x0d;

  rows.forEach((row, r) => {
    let p = headerLength + r * recordLength;
    out[p++] = 0x20;
    for (const d of descs) {
      const v = row[d.field.name];
      let text = '';
      if (v !== null && v !== undefined && v !== '') {
        switch (d.type) {
          case 'N': {
            const num = typeof v === 'number' ? v : Number(v);
            if (Number.isFinite(num)) {
              let dec = d.decimals;
              text = dec ? num.toFixed(dec) : String(Math.trunc(num));
              while (text.length > d.length && dec > 0) text = num.toFixed(--dec);
              if (text.length > d.length) text = num.toExponential(Math.max(0, d.length - 7));
            }
            text = text.padStart(d.length, ' ');
            break;
          }
          case 'L':
            text = v === true || v === 'true' || v === 1 ? 'T' : 'F';
            break;
          case 'D': {
            const s = v instanceof Date ? v.toISOString() : String(v);
            text = s.replace(/-/g, '').slice(0, 8);
            break;
          }
          default:
            text = String(v);
        }
      }
      const bytes = d.type === 'C' ? truncateUtf8(text, d.length) : enc.encode(text.slice(0, d.length));
      out.fill(0x20, p, p + d.length);
      out.set(bytes, p);
      p += d.length;
    }
  });
  out[out.length - 1] = 0x1a;
  return out;
}
