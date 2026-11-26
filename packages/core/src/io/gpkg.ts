import type { Database, SqlJsStatic } from 'sql.js';
import { bbox, hasZ as geomHasZ } from '../geom/coords.js';
import type { FieldDef, FieldType } from '../types.js';
import { epsgNumber } from '../crs/crs.js';
import type { ImportedFeature, IoConfig, WriterInput } from './types.js';
import { readWkb, writeWkb } from './wkb.js';

let sqlPromise: Promise<SqlJsStatic> | null = null;
let sqlWasmUrl: string | undefined;

export function configureSqlJs(url: string | undefined): void {
  if (url !== sqlWasmUrl) {
    sqlWasmUrl = url;
    sqlPromise = null;
  }
}

const DEFAULT_SQL_WASM = 'https://cdn.jsdelivr.net/npm/sql.js@1.17.0/dist/sql-wasm.wasm';

async function getSql(config?: IoConfig): Promise<SqlJsStatic> {
  if (config?.sqlWasmUrl) configureSqlJs(config.sqlWasmUrl);
  if (!sqlPromise) {
    const url = sqlWasmUrl ?? DEFAULT_SQL_WASM;
    sqlPromise = import('sql.js').then((m) => {
      const init = (m as unknown as { default: (cfg: object) => Promise<SqlJsStatic> }).default;
      return init({ locateFile: () => url });
    });
  }
  return sqlPromise;
}

export interface GpkgLayer {
  table: string;
  geometryColumn: string;
  features: ImportedFeature[];
  fields: FieldDef[];
  srsCode: string | null;
  srsWkt: string | null;
  hasZ: boolean;
}

/** Lee todas las tablas de entidades de un GeoPackage. Coordenadas en el CRS de la tabla. */
export async function readGeoPackage(bytes: Uint8Array, config?: IoConfig): Promise<GpkgLayer[]> {
  const SQL = await getSql(config);
  const db = new SQL.Database(bytes);
  try {
    const tables = rows(
      db,
      `SELECT c.table_name, g.column_name, g.srs_id, g.z, s.organization, s.organization_coordsys_id, s.definition
       FROM gpkg_contents c
       JOIN gpkg_geometry_columns g ON g.table_name = c.table_name
       LEFT JOIN gpkg_spatial_ref_sys s ON s.srs_id = g.srs_id
       WHERE c.data_type = 'features'`,
    );
    const out: GpkgLayer[] = [];
    for (const t of tables) {
      const table = String(t['table_name']);
      const geomCol = String(t['column_name']);
      const cols = rows(db, `PRAGMA table_info(${quoteId(table)})`);
      const pk = cols.find((c) => Number(c['pk']) === 1)?.['name'] as string | undefined;
      const attrCols = cols.filter((c) => c['name'] !== geomCol && c['name'] !== pk);
      const fields: FieldDef[] = attrCols.map((c) => ({ name: String(c['name']), type: sqlTypeToField(String(c['type'])) }));

      const stmt = db.prepare(`SELECT * FROM ${quoteId(table)}`);
      const features: ImportedFeature[] = [];
      let z = Number(t['z']) === 1;
      while (stmt.step()) {
        const row = stmt.getAsObject();
        const blob = row[geomCol] as Uint8Array | null;
        const geometry = blob && blob.byteLength ? parseGpkgBlob(blob) : null;
        if (geometry && geomHasZ(geometry)) z = true;
        const properties: Record<string, unknown> = {};
        for (const f of fields) {
          const v = row[f.name];
          properties[f.name] = f.type === 'boolean' && typeof v === 'number' ? v === 1 : v ?? null;
        }
        features.push({ geometry, properties, ...(pk && row[pk] != null ? { id: row[pk] as number } : {}) });
      }
      stmt.free();

      const org = String(t['organization'] ?? '').toUpperCase();
      const code = t['organization_coordsys_id'];
      out.push({
        table,
        geometryColumn: geomCol,
        features,
        fields,
        srsCode: org === 'EPSG' && code != null && Number(code) > 0 ? `EPSG:${code}` : null,
        srsWkt: t['definition'] && t['definition'] !== 'undefined' ? String(t['definition']) : null,
        hasZ: z,
      });
    }
    return out;
  } finally {
    db.close();
  }
}

/** Decodifica una geometría GeoPackage (cabecera GP + WKB). */
export function parseGpkgBlob(blob: Uint8Array) {
  if (blob[0] !== 0x47 || blob[1] !== 0x50) throw new Error('Geometría GeoPackage no válida');
  const flags = blob[3]!;
  const empty = (flags >> 4) & 1;
  const envelope = (flags >> 1) & 0b111;
  const envSize = [0, 32, 48, 48, 64][envelope] ?? 0;
  if (empty) return null;
  return readWkb(blob, 8 + envSize).geometry;
}

export function buildGpkgBlob(geometry: NonNullable<ReturnType<typeof parseGpkgBlob>>, srsId: number, withZ: boolean): Uint8Array {
  const wkb = writeWkb(geometry, withZ);
  const env = bbox(geometry);
  const header = new Uint8Array(8 + (env ? 32 : 0));
  const dv = new DataView(header.buffer);
  header[0] = 0x47;
  header[1] = 0x50;
  header[2] = 0;
  header[3] = 0b00000001 | (env ? 0b10 : 0); // little endian + envelope [minx,maxx,miny,maxy]
  dv.setInt32(4, srsId, true);
  if (env) {
    dv.setFloat64(8, env[0], true);
    dv.setFloat64(16, env[2], true);
    dv.setFloat64(24, env[1], true);
    dv.setFloat64(32, env[3], true);
  }
  const out = new Uint8Array(header.byteLength + wkb.byteLength);
  out.set(header);
  out.set(wkb, header.byteLength);
  return out;
}

const GEOM_TYPE_NAME: Record<string, string> = {
  Point: 'POINT',
  LineString: 'LINESTRING',
  Polygon: 'POLYGON',
  Mixed: 'GEOMETRY',
};

/** Escribe un GeoPackage con una tabla de entidades. */
export async function writeGeoPackage(
  input: WriterInput,
  wkt: string | null,
  extraField: { name: string; values: string[] } | undefined,
  config?: IoConfig,
): Promise<Uint8Array> {
  const SQL = await getSql(config);
  const db = new SQL.Database();
  try {
    const table = sanitizeTable(String(input.layer.source.formatOptions?.['table'] ?? input.baseName));
    const epsg = epsgNumber(input.crs);
    const srsId = epsg ?? 100000;
    const fields = extraField ? [...input.fields, { name: extraField.name, type: 'string' as const }] : input.fields;
    db.run(`PRAGMA application_id = 1196444487; PRAGMA user_version = 10400;`);
    db.run(`
      CREATE TABLE gpkg_spatial_ref_sys (srs_name TEXT NOT NULL, srs_id INTEGER PRIMARY KEY, organization TEXT NOT NULL,
        organization_coordsys_id INTEGER NOT NULL, definition TEXT NOT NULL, description TEXT);
      CREATE TABLE gpkg_contents (table_name TEXT NOT NULL PRIMARY KEY, data_type TEXT NOT NULL, identifier TEXT UNIQUE,
        description TEXT DEFAULT '', last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        min_x DOUBLE, min_y DOUBLE, max_x DOUBLE, max_y DOUBLE, srs_id INTEGER,
        CONSTRAINT fk_gc_r_srs_id FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys(srs_id));
      CREATE TABLE gpkg_geometry_columns (table_name TEXT NOT NULL, column_name TEXT NOT NULL, geometry_type_name TEXT NOT NULL,
        srs_id INTEGER NOT NULL, z TINYINT NOT NULL, m TINYINT NOT NULL,
        CONSTRAINT pk_geom_cols PRIMARY KEY (table_name, column_name),
        CONSTRAINT fk_gc_tn FOREIGN KEY (table_name) REFERENCES gpkg_contents(table_name),
        CONSTRAINT fk_gc_srs FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys (srs_id));
    `);
    const insSrs = db.prepare('INSERT INTO gpkg_spatial_ref_sys VALUES (?,?,?,?,?,?)');
    insSrs.run(['Undefined cartesian SRS', -1, 'NONE', -1, 'undefined', null]);
    insSrs.run(['Undefined geographic SRS', 0, 'NONE', 0, 'undefined', null]);
    insSrs.run([
      'WGS 84 geodetic',
      4326,
      'EPSG',
      4326,
      'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433],AUTHORITY["EPSG","4326"]]',
      null,
    ]);
    if (srsId !== 4326) insSrs.run([input.crs, srsId, epsg ? 'EPSG' : 'NONE', epsg ?? srsId, wkt ?? 'undefined', null]);
    insSrs.free();

    const env = boundsOf(input);
    db.run('INSERT INTO gpkg_contents (table_name, data_type, identifier, min_x, min_y, max_x, max_y, srs_id) VALUES (?,?,?,?,?,?,?,?)', [
      table,
      'features',
      input.layer.name,
      env?.[0] ?? null,
      env?.[1] ?? null,
      env?.[2] ?? null,
      env?.[3] ?? null,
      srsId,
    ]);
    const anyMulti = input.features.some((f) => f.geometry?.type.startsWith('Multi'));
    const gType = anyMulti && input.layer.geometryKind !== 'Mixed' ? `MULTI${GEOM_TYPE_NAME[input.layer.geometryKind]}` : (GEOM_TYPE_NAME[input.layer.geometryKind] ?? 'GEOMETRY');
    db.run('INSERT INTO gpkg_geometry_columns VALUES (?,?,?,?,?,?)', [table, 'geom', gType, srsId, input.hasZ ? 1 : 0, 0]);

    const colDefs = fields.map((f) => `${quoteId(f.name)} ${fieldToSqlType(f.type)}`);
    db.run(`CREATE TABLE ${quoteId(table)} (fid INTEGER PRIMARY KEY AUTOINCREMENT, geom BLOB${colDefs.length ? ', ' + colDefs.join(', ') : ''})`);

    const placeholders = ['?', '?', ...fields.map(() => '?')].join(',');
    const ins = db.prepare(`INSERT INTO ${quoteId(table)} (fid, geom${fields.map((f) => ', ' + quoteId(f.name)).join('')}) VALUES (${placeholders})`);
    db.run('BEGIN');
    const usedFids = new Set<number>();
    input.features.forEach((f, i) => {
      const fid = typeof f.sourceId === 'number' && !usedFids.has(f.sourceId) ? f.sourceId : null;
      if (fid !== null) usedFids.add(fid);
      const values = fields.map((fd) => {
        const v = fd.name === extraField?.name ? extraField.values[i] : f.properties[fd.name];
        if (v === undefined || v === null) return null;
        if (typeof v === 'boolean') return v ? 1 : 0;
        if (typeof v === 'number' || typeof v === 'string') return v;
        return JSON.stringify(v);
      });
      ins.run([fid, f.geometry ? buildGpkgBlob(f.geometry, srsId, input.hasZ) : null, ...values]);
    });
    db.run('COMMIT');
    ins.free();
    return db.export();
  } finally {
    db.close();
  }
}

function boundsOf(input: WriterInput) {
  let b: [number, number, number, number] | null = null;
  for (const f of input.features) {
    const e = bbox(f.geometry);
    if (!e) continue;
    b = b ? [Math.min(b[0], e[0]), Math.min(b[1], e[1]), Math.max(b[2], e[2]), Math.max(b[3], e[3])] : e;
  }
  return b;
}

function rows(db: Database, sql: string): Array<Record<string, unknown>> {
  const res = db.exec(sql);
  if (!res.length) return [];
  const { columns, values } = res[0]!;
  return values.map((v) => Object.fromEntries(columns.map((c, i) => [c, v[i]])));
}

const quoteId = (s: string) => `"${s.replace(/"/g, '""')}"`;
const sanitizeTable = (s: string) => s.replace(/[^\p{L}\p{N}_]/gu, '_').replace(/^(\d)/, '_$1') || 'capa';

function sqlTypeToField(t: string): FieldType {
  const s = t.toUpperCase();
  if (/INT/.test(s)) return 'integer';
  if (/REAL|FLOAT|DOUBLE|NUMERIC/.test(s)) return 'number';
  if (/BOOL/.test(s)) return 'boolean';
  if (/DATE/.test(s)) return 'date';
  return 'string';
}

function fieldToSqlType(t: FieldType): string {
  switch (t) {
    case 'integer':
      return 'INTEGER';
    case 'number':
      return 'REAL';
    case 'boolean':
      return 'BOOLEAN';
    case 'date':
      return 'DATE';
    default:
      return 'TEXT';
  }
}
