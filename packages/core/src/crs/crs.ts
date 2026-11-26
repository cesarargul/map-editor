import type { Geometry, Position } from 'geojson';
import proj4 from 'proj4';
import { mapCoords } from '../geom/coords.js';

/**
 * Definiciones proj4 de los CRS habituales en España. Se pueden añadir más con `registerCrs`.
 * Nota: ED50 usa parámetros towgs84 aproximados (error ~1-2 m). Para precisión centimétrica
 * hace falta la rejilla NTv2 oficial del IGN.
 */
const DEFS: Record<string, string> = {
  'EPSG:4326': '+proj=longlat +datum=WGS84 +no_defs',
  'EPSG:4258': '+proj=longlat +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +no_defs',
  'EPSG:4230': '+proj=longlat +ellps=intl +towgs84=-87,-98,-121,0,0,0,0 +no_defs',
  'EPSG:3857': '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs',
  'EPSG:4081': '+proj=longlat +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +no_defs', // REGCAN95
  'EPSG:4083': '+proj=utm +zone=28 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs', // REGCAN95 / UTM 28N
  'EPSG:4082': '+proj=utm +zone=27 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs', // REGCAN95 / UTM 27N
};

for (const zone of [28, 29, 30, 31]) {
  DEFS[`EPSG:258${zone}`] = `+proj=utm +zone=${zone} +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs`;
  DEFS[`EPSG:326${zone}`] = `+proj=utm +zone=${zone} +datum=WGS84 +units=m +no_defs`;
  DEFS[`EPSG:230${zone}`] = `+proj=utm +zone=${zone} +ellps=intl +towgs84=-87,-98,-121,0,0,0,0 +units=m +no_defs`;
}

for (const [code, def] of Object.entries(DEFS)) proj4.defs(code, def);

export const KNOWN_CRS: Array<{ code: string; name: string }> = [
  { code: 'EPSG:4326', name: 'WGS 84 (geográficas)' },
  { code: 'EPSG:4258', name: 'ETRS89 (geográficas)' },
  { code: 'EPSG:3857', name: 'WGS 84 / Pseudo-Mercator' },
  { code: 'EPSG:25828', name: 'ETRS89 / UTM 28N' },
  { code: 'EPSG:25829', name: 'ETRS89 / UTM 29N' },
  { code: 'EPSG:25830', name: 'ETRS89 / UTM 30N' },
  { code: 'EPSG:25831', name: 'ETRS89 / UTM 31N' },
  { code: 'EPSG:32628', name: 'WGS 84 / UTM 28N' },
  { code: 'EPSG:32629', name: 'WGS 84 / UTM 29N' },
  { code: 'EPSG:32630', name: 'WGS 84 / UTM 30N' },
  { code: 'EPSG:32631', name: 'WGS 84 / UTM 31N' },
  { code: 'EPSG:4083', name: 'REGCAN95 / UTM 28N' },
  { code: 'EPSG:23029', name: 'ED50 / UTM 29N' },
  { code: 'EPSG:23030', name: 'ED50 / UTM 30N' },
  { code: 'EPSG:23031', name: 'ED50 / UTM 31N' },
];

export function registerCrs(code: string, definition: string): void {
  proj4.defs(normalizeCrsCode(code), definition);
}

export function isCrsKnown(code: string): boolean {
  return proj4.defs(normalizeCrsCode(code)) !== undefined;
}

/** Normaliza "urn:ogc:def:crs:EPSG::25830", "EPSG:25830", "25830", "http://www.opengis.net/def/crs/EPSG/0/25830"… */
export function normalizeCrsCode(input: string | number): string {
  const s = String(input).trim();
  if (/^CRS:?84$/i.test(s) || /OGC.*CRS84/i.test(s)) return 'EPSG:4326';
  const m = s.match(/EPSG(?::|::|\/0\/|\/)(\d+)$/i) ?? s.match(/^(\d+)$/);
  if (m) return `EPSG:${m[1]}`;
  return s;
}

/**
 * Intenta identificar un código EPSG a partir de un WKT (de `.prj` o GeoPackage).
 * Devuelve `null` si no se reconoce; en ese caso se puede registrar el WKT directamente.
 */
export function crsFromWkt(wkt: string): string | null {
  const authority = wkt.match(/AUTHORITY\["EPSG",\s*"?(\d+)"?\]\s*\]\s*$/i) ?? wkt.match(/ID\["EPSG",\s*(\d+)\]\s*\]\s*$/i);
  if (authority) return `EPSG:${authority[1]}`;
  const name = (wkt.match(/^\s*(?:PROJCS|PROJCRS|GEOGCS|GEOGCRS)\["([^"]+)"/i)?.[1] ?? '').toLowerCase().replace(/[\s_]+/g, ' ');
  const utm = name.match(/utm zone (\d+)\s*n/);
  if (utm) {
    const zone = utm[1]!;
    if (/etrs/.test(name)) return `EPSG:258${zone}`;
    if (/wgs/.test(name)) return `EPSG:326${zone}`;
    if (/ed50|european datum 1950/.test(name)) return `EPSG:230${zone}`;
    if (/regcan/.test(name)) return zone === '27' ? 'EPSG:4082' : 'EPSG:4083';
  }
  if (/pseudo.mercator|web mercator|popular visualisation/.test(name)) return 'EPSG:3857';
  if (/^(gcs )?etrs( 19)?89$/.test(name) || name === 'gcs etrs 1989') return 'EPSG:4258';
  if (/^(gcs )?wgs( 19)?84$/.test(name) || name === 'gcs wgs 1984' || name === 'wgs 84') return 'EPSG:4326';
  if (/^(gcs )?(ed50|european 1950)$/.test(name)) return 'EPSG:4230';
  return null;
}

/** Resuelve un CRS (código o WKT) a un código usable por proj4, registrándolo si hace falta. */
export function resolveCrs(codeOrWkt: string | null | undefined): string {
  if (!codeOrWkt) return 'EPSG:4326';
  const s = codeOrWkt.trim();
  if (/^(PROJCS|GEOGCS|PROJCRS|GEOGCRS|COMPD_CS|COMPOUNDCRS)\[/i.test(s)) {
    const known = crsFromWkt(s);
    if (known && isCrsKnown(known)) return known;
    const key = known ?? `WKT:${hash(s)}`;
    try {
      proj4.defs(key, s);
      return key;
    } catch {
      throw new Error('CRS no soportado (WKT no reconocido)');
    }
  }
  const code = normalizeCrsCode(s);
  if (!isCrsKnown(code)) throw new Error(`CRS no soportado: ${code}. Regístralo con registerCrs().`);
  return code;
}

const isWgs84 = (crs: string) => crs === 'EPSG:4326' || crs === 'EPSG:4258' || crs === 'EPSG:4081';

/**
 * Transforma una geometría entre CRS. Solo transforma XY y conserva la Z tal cual
 * (proj4 alteraría la altura al pasar por geocéntricas en los cambios de datum).
 */
export function transformGeometry(geometry: Geometry, from: string, to: string): Geometry {
  if (from === to || (isWgs84(from) && isWgs84(to))) return geometry;
  const conv = proj4(from, to);
  return mapCoords(geometry, (c) => {
    const xy = conv.forward([c[0]!, c[1]!]);
    return c.length > 2 ? [xy[0]!, xy[1]!, ...c.slice(2)] : [xy[0]!, xy[1]!];
  });
}

export function transformPosition(c: Position, from: string, to: string): Position {
  if (from === to || (isWgs84(from) && isWgs84(to))) return c;
  const xy = proj4(from, to).forward([c[0]!, c[1]!]);
  return c.length > 2 ? [xy[0]!, xy[1]!, ...c.slice(2)] : [xy[0]!, xy[1]!];
}

/**
 * Heurística para datos sin CRS declarado: si las coordenadas no son geográficas
 * y caen en el rango UTM peninsular/canario, se asume ETRS89 / UTM.
 */
export function guessCrs(sample: Position[]): { crs: string; guessed: boolean } {
  const pts = sample.filter((c) => Number.isFinite(c[0]) && Number.isFinite(c[1]));
  if (pts.length === 0) return { crs: 'EPSG:4326', guessed: false };
  const geographic = pts.every((c) => Math.abs(c[0]!) <= 180 && Math.abs(c[1]!) <= 90);
  if (geographic) return { crs: 'EPSG:4326', guessed: false };
  const ys = pts.map((c) => c[1]!);
  const xs = pts.map((c) => c[0]!);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  if (minX > 100_000 && maxX < 900_000) {
    if (minY > 3_000_000 && maxY < 3_300_000) return { crs: 'EPSG:4083', guessed: true }; // Canarias
    if (minY > 3_900_000 && maxY < 4_900_000) return { crs: 'EPSG:25830', guessed: true };
  }
  if (Math.abs(minX) < 20037509 && Math.abs(maxY) < 20037509) return { crs: 'EPSG:3857', guessed: true };
  return { crs: 'EPSG:4326', guessed: true };
}

// --- WKT para escribir .prj ---------------------------------------------------------------

const GEOGCS_ETRS89 =
  'GEOGCS["GCS_ETRS_1989",DATUM["D_ETRS_1989",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';
const GEOGCS_WGS84 =
  'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';
const GEOGCS_ED50 =
  'GEOGCS["GCS_European_1950",DATUM["D_European_1950",SPHEROID["International_1924",6378388.0,297.0]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';

function utmWkt(name: string, geogcs: string, zone: number): string {
  const cm = -183 + 6 * zone;
  return `PROJCS["${name}",${geogcs},PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",${cm.toFixed(1)}],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]`;
}

/** WKT (dialecto ESRI, el que entienden QGIS/ArcGIS en un `.prj`) para los CRS conocidos. */
export function wktForCrs(code: string): string | null {
  if (code === 'EPSG:4326') return GEOGCS_WGS84;
  if (code === 'EPSG:4258') return GEOGCS_ETRS89;
  if (code === 'EPSG:4230') return GEOGCS_ED50;
  if (code === 'EPSG:3857')
    return `PROJCS["WGS_1984_Web_Mercator_Auxiliary_Sphere",${GEOGCS_WGS84},PROJECTION["Mercator_Auxiliary_Sphere"],PARAMETER["False_Easting",0.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",0.0],PARAMETER["Standard_Parallel_1",0.0],PARAMETER["Auxiliary_Sphere_Type",0.0],UNIT["Meter",1.0]]`;
  const m = code.match(/^EPSG:(258|326|230)(\d\d)$/);
  if (m) {
    const zone = Number(m[2]);
    if (m[1] === '258') return utmWkt(`ETRS_1989_UTM_Zone_${zone}N`, GEOGCS_ETRS89, zone);
    if (m[1] === '326') return utmWkt(`WGS_1984_UTM_Zone_${zone}N`, GEOGCS_WGS84, zone);
    return utmWkt(`ED_1950_UTM_Zone_${zone}N`, GEOGCS_ED50, zone);
  }
  if (code === 'EPSG:4083') return utmWkt('REGCAN95_UTM_Zone_28N', GEOGCS_ETRS89.replace(/ETRS_1989/g, 'REGCAN95'), 28);
  return null;
}

export function epsgNumber(code: string): number | null {
  const m = code.match(/^EPSG:(\d+)$/);
  return m ? Number(m[1]) : null;
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}
