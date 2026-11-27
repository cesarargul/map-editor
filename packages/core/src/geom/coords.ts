import type { Geometry, Position } from 'geojson';
import type { GeometryKind } from '../types.js';

/**
 * Ruta de un vértice dentro de la geometría:
 * - Point: []
 * - MultiPoint / LineString: [i]
 * - Polygon / MultiLineString: [anillo|parte, i]
 * - MultiPolygon: [polígono, anillo, i]
 */
export type VertexPath = number[];

export interface VertexRef {
  path: VertexPath;
  coord: Position;
  /** Es el primer o último vértice de una línea abierta. */
  isEndpoint: boolean;
}

export interface SegmentRef {
  a: Position;
  b: Position;
  pathA: VertexPath;
  pathB: VertexPath;
  /** Ruta donde insertar un vértice nuevo entre a y b. */
  insertPath: VertexPath;
}

type Ring = Position[];

/** Líneas "abiertas" o anillos de la geometría junto con su prefijo de ruta. */
export function linearParts(geometry: Geometry): Array<{ prefix: number[]; coords: Position[]; closed: boolean }> {
  switch (geometry.type) {
    case 'LineString':
      return [{ prefix: [], coords: geometry.coordinates, closed: false }];
    case 'MultiLineString':
      return geometry.coordinates.map((coords, i) => ({ prefix: [i], coords, closed: false }));
    case 'Polygon':
      return geometry.coordinates.map((coords, i) => ({ prefix: [i], coords, closed: true }));
    case 'MultiPolygon':
      return geometry.coordinates.flatMap((poly, p) =>
        poly.map((coords, r) => ({ prefix: [p, r], coords, closed: true })),
      );
    default:
      return [];
  }
}

/** Todos los vértices editables (en anillos se omite el vértice de cierre duplicado). */
export function getVertices(geometry: Geometry | null): VertexRef[] {
  if (!geometry) return [];
  switch (geometry.type) {
    case 'Point':
      return [{ path: [], coord: geometry.coordinates, isEndpoint: false }];
    case 'MultiPoint':
      return geometry.coordinates.map((coord, i) => ({ path: [i], coord, isEndpoint: false }));
    case 'GeometryCollection':
      return [];
    default: {
      const out: VertexRef[] = [];
      for (const part of linearParts(geometry)) {
        const n = part.closed ? part.coords.length - 1 : part.coords.length;
        for (let i = 0; i < n; i++) {
          out.push({
            path: [...part.prefix, i],
            coord: part.coords[i]!,
            isEndpoint: !part.closed && (i === 0 || i === n - 1),
          });
        }
      }
      return out;
    }
  }
}

export function getSegments(geometry: Geometry | null): SegmentRef[] {
  if (!geometry) return [];
  const out: SegmentRef[] = [];
  for (const part of linearParts(geometry)) {
    const c = part.coords;
    const n = part.closed ? c.length - 1 : c.length;
    for (let i = 0; i < c.length - 1; i++) {
      const j = part.closed && i + 1 === n ? 0 : i + 1;
      out.push({
        a: c[i]!,
        b: c[i + 1]!,
        pathA: [...part.prefix, i],
        pathB: [...part.prefix, j],
        insertPath: [...part.prefix, i + 1],
      });
    }
  }
  return out;
}

function locate(geometry: Geometry, path: VertexPath): { arr: Position[]; index: number; closed: boolean } | null {
  switch (geometry.type) {
    case 'MultiPoint':
      return path.length === 1 ? { arr: geometry.coordinates, index: path[0]!, closed: false } : null;
    case 'LineString':
      return path.length === 1 ? { arr: geometry.coordinates, index: path[0]!, closed: false } : null;
    case 'MultiLineString': {
      const arr = geometry.coordinates[path[0]!];
      return arr && path.length === 2 ? { arr, index: path[1]!, closed: false } : null;
    }
    case 'Polygon': {
      const arr = geometry.coordinates[path[0]!];
      return arr && path.length === 2 ? { arr, index: path[1]!, closed: true } : null;
    }
    case 'MultiPolygon': {
      const arr = geometry.coordinates[path[0]!]?.[path[1]!];
      return arr && path.length === 3 ? { arr, index: path[2]!, closed: true } : null;
    }
    default:
      return null;
  }
}

export function getVertex(geometry: Geometry, path: VertexPath): Position | null {
  if (geometry.type === 'Point') return path.length === 0 ? geometry.coordinates : null;
  const loc = locate(geometry, path);
  return loc ? (loc.arr[loc.index] ?? null) : null;
}

/** Mueve un vértice (modifica la geometría en sitio). Mantiene cerrados los anillos. */
export function setVertex(geometry: Geometry, path: VertexPath, coord: Position): void {
  if (geometry.type === 'Point') {
    geometry.coordinates = [...coord];
    return;
  }
  const loc = locate(geometry, path);
  if (!loc) throw new Error(`Ruta de vértice no válida: ${path.join(',')}`);
  loc.arr[loc.index] = [...coord];
  if (loc.closed) {
    const last = loc.arr.length - 1;
    if (loc.index === 0) loc.arr[last] = [...coord];
    else if (loc.index === last) loc.arr[0] = [...coord];
  }
}

/** Inserta un vértice en la posición indicada (modifica en sitio). */
export function insertVertex(geometry: Geometry, path: VertexPath, coord: Position): void {
  const loc = locate(geometry, path);
  if (!loc || geometry.type === 'MultiPoint') throw new Error(`No se puede insertar en ${path.join(',')}`);
  loc.arr.splice(loc.index, 0, [...coord]);
}

/**
 * Elimina un vértice (modifica en sitio). Devuelve `false` si la geometría quedaría inválida
 * (línea con menos de 2 vértices o anillo con menos de 3).
 */
export function removeVertex(geometry: Geometry, path: VertexPath): boolean {
  const loc = locate(geometry, path);
  if (!loc) return false;
  const { arr, index, closed } = loc;
  if (geometry.type === 'MultiPoint') {
    if (arr.length <= 1) return false;
    arr.splice(index, 1);
    return true;
  }
  if (closed) {
    if (arr.length - 1 <= 3) return false;
    const last = arr.length - 1;
    if (index === 0 || index === last) {
      arr.splice(last, 1);
      arr.splice(0, 1);
      arr.push([...arr[0]!]);
    } else {
      arr.splice(index, 1);
    }
    return true;
  }
  if (arr.length <= 2) return false;
  arr.splice(index, 1);
  return true;
}

/** Aplica una función a todas las posiciones (devuelve geometría nueva). */
export function mapCoords(geometry: Geometry, fn: (c: Position) => Position): Geometry {
  switch (geometry.type) {
    case 'Point':
      return { type: 'Point', coordinates: fn(geometry.coordinates) };
    case 'MultiPoint':
      return { type: 'MultiPoint', coordinates: geometry.coordinates.map(fn) };
    case 'LineString':
      return { type: 'LineString', coordinates: geometry.coordinates.map(fn) };
    case 'MultiLineString':
      return { type: 'MultiLineString', coordinates: geometry.coordinates.map((l) => l.map(fn)) };
    case 'Polygon':
      return { type: 'Polygon', coordinates: geometry.coordinates.map((r) => r.map(fn)) };
    case 'MultiPolygon':
      return { type: 'MultiPolygon', coordinates: geometry.coordinates.map((p) => p.map((r) => r.map(fn))) };
    case 'GeometryCollection':
      return { type: 'GeometryCollection', geometries: geometry.geometries.map((g) => mapCoords(g, fn)) };
  }
}

export function forEachCoord(geometry: Geometry | null, fn: (c: Position) => void): void {
  if (!geometry) return;
  mapCoords(geometry, (c) => {
    fn(c);
    return c;
  });
}

export function bbox(geometry: Geometry | null): [number, number, number, number] | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  forEachCoord(geometry, (c) => {
    const x = c[0]!;
    const y = c[1]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  });
  return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : null;
}

export function hasZ(geometry: Geometry | null): boolean {
  let z = false;
  forEachCoord(geometry, (c) => {
    if (c.length > 2 && Number.isFinite(c[2])) z = true;
  });
  return z;
}

/** Tipo de geometría "familia" (Point/LineString/Polygon) de una geometría. */
export function geometryFamily(geometry: Geometry | null): Exclude<GeometryKind, 'Mixed'> | null {
  if (!geometry) return null;
  switch (geometry.type) {
    case 'Point':
    case 'MultiPoint':
      return 'Point';
    case 'LineString':
    case 'MultiLineString':
      return 'LineString';
    case 'Polygon':
    case 'MultiPolygon':
      return 'Polygon';
    default:
      return null;
  }
}

export function inferGeometryKind(geometries: Iterable<Geometry | null>): GeometryKind {
  let kind: GeometryKind | null = null;
  for (const g of geometries) {
    const f = geometryFamily(g);
    if (!f) continue;
    if (kind === null) kind = f;
    else if (kind !== f) return 'Mixed';
  }
  return kind ?? 'Mixed';
}

/** Área con signo (fórmula del lazo) en el plano XY. Positiva = antihoraria. */
export function signedArea(ring: Ring): number {
  let sum = 0;
  for (let i = 0, n = ring.length; i < n - 1; i++) {
    const a = ring[i]!;
    const b = ring[i + 1]!;
    sum += a[0]! * b[1]! - b[0]! * a[1]!;
  }
  return sum / 2;
}

export function pointInRing(pt: Position, ring: Ring): boolean {
  let inside = false;
  const x = pt[0]!;
  const y = pt[1]!;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]![0]!;
    const yi = ring[i]![1]!;
    const xj = ring[j]![0]!;
    const yj = ring[j]![1]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function closeRing(ring: Ring): Ring {
  if (ring.length === 0) return ring;
  const a = ring[0]!;
  const b = ring[ring.length - 1]!;
  if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) return [...ring, [...a]];
  return ring;
}

export function samePosition(a: Position, b: Position, eps = 1e-12): boolean {
  return Math.abs(a[0]! - b[0]!) <= eps && Math.abs(a[1]! - b[1]!) <= eps;
}

// --- Web Mercator (metros) ----------------------------------------------------------------

const R = 6378137;
const MAX_LAT = 85.0511287798;

export function toMercator(c: Position): Position {
  const lat = Math.max(-MAX_LAT, Math.min(MAX_LAT, c[1]!));
  const x = (R * c[0]! * Math.PI) / 180;
  const y = R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  return c.length > 2 ? [x, y, c[2]!] : [x, y];
}

export function fromMercator(c: Position): Position {
  const lon = (c[0]! / R) * (180 / Math.PI);
  const lat = (2 * Math.atan(Math.exp(c[1]! / R)) - Math.PI / 2) * (180 / Math.PI);
  return c.length > 2 ? [lon, lat, c[2]!] : [lon, lat];
}

/** Traslada una geometría un desplazamiento en metros Web Mercator (conserva Z). */
export function translateMercator(geometry: Geometry, dx: number, dy: number): Geometry {
  return mapCoords(geometry, (c) => {
    const m = toMercator(c);
    m[0] = m[0]! + dx;
    m[1] = m[1]! + dy;
    return fromMercator(m);
  });
}

/** Elimina vértices consecutivos repetidos de líneas y anillos. */
export function dedupeConsecutive(coords: Position[]): Position[] {
  const out: Position[] = [];
  for (const c of coords) {
    const prev = out[out.length - 1];
    if (!prev || !samePosition(prev, c)) out.push(c);
  }
  return out;
}

// --- Coherencia de la coordenada Z -----------------------------------------------------------

/** Quita la Z de todas las posiciones. */
export function stripZ(geometry: Geometry): Geometry {
  return mapCoords(geometry, (c) => (c.length > 2 ? [c[0]!, c[1]!] : c));
}

function fillSequence(seq: Position[], defaultZ: number): void {
  let first: number | undefined;
  for (const c of seq) {
    if (c.length > 2 && Number.isFinite(c[2])) {
      first = c[2]!;
      break;
    }
  }
  let prev = first ?? defaultZ;
  for (const c of seq) {
    if (c.length > 2 && Number.isFinite(c[2])) prev = c[2]!;
    else c[2] = prev;
  }
}

/**
 * Completa la Z que falta (devuelve una geometría nueva). En líneas y anillos, un vértice sin Z
 * continúa a la cota del anterior; los del principio toman la del primero que sí la tiene; si
 * ninguno la tiene, `defaultZ`. En puntos, `defaultZ`.
 */
export function fillMissingZ(geometry: Geometry, defaultZ: number): Geometry {
  const out = mapCoords(geometry, (c) => [...c]);
  switch (out.type) {
    case 'Point':
      if (out.coordinates.length < 3) out.coordinates[2] = defaultZ;
      break;
    case 'MultiPoint':
      for (const c of out.coordinates) if (c.length < 3) c[2] = defaultZ;
      break;
    default:
      for (const part of linearParts(out)) {
        if (part.closed) {
          const open = part.coords.slice(0, -1);
          fillSequence(open, defaultZ);
          part.coords[part.coords.length - 1] = [...open[0]!];
        } else fillSequence(part.coords, defaultZ);
      }
  }
  return out;
}

export interface LayerZRule {
  /** La capa es 3D. */
  hasZ: boolean;
  /** Capa creada en el editor (puede pasar a 3D); las de fichero conservan su dimensión. */
  memory: boolean;
  defaultZ: number;
}

export interface ZResolution {
  geometry: Geometry;
  /** La capa debe pasar a 3D (la geometría trae Z y la capa es nueva y 2D). */
  promote: boolean;
  /** Se ha descartado la Z porque la capa es 2D y viene de un fichero. */
  stripped: boolean;
}

/**
 * Hace coherente la Z de una geometría con la capa que la contiene, para que el snap posterior
 * la reconozca siempre:
 * - capa 3D: completa la Z que falte;
 * - capa nueva 2D con Z en la geometría (p. ej. por enganchar a algo 3D): pasa a 3D;
 * - capa 2D de fichero: descarta la Z.
 */
export function resolveGeometryZ(geometry: Geometry, layer: LayerZRule): ZResolution {
  if (layer.hasZ) return { geometry: fillMissingZ(geometry, layer.defaultZ), promote: false, stripped: false };
  if (!hasZ(geometry)) return { geometry, promote: false, stripped: false };
  if (layer.memory) return { geometry: fillMissingZ(geometry, layer.defaultZ), promote: true, stripped: false };
  return { geometry: stripZ(geometry), promote: false, stripped: true };
}
