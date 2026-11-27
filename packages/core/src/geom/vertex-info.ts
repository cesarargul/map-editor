import type { Geometry, Position } from 'geojson';
import { getVertices, linearParts, type VertexPath } from './coords.js';

const EARTH_RADIUS = 6371008.8;

/** Distancia horizontal (m) entre dos posiciones lon/lat, por la fórmula del haversine. */
export function haversine(a: Position, b: Position): number {
  const rad = Math.PI / 180;
  const dLat = (b[1]! - a[1]!) * rad;
  const dLon = (b[0]! - a[0]!) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1]! * rad) * Math.cos(b[1]! * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Longitud horizontal total (m) de líneas o perímetro de polígonos; 0 en puntos. */
export function lengthM(geometry: Geometry | null): number {
  if (!geometry) return 0;
  let total = 0;
  for (const part of linearParts(geometry)) {
    for (let i = 1; i < part.coords.length; i++) total += haversine(part.coords[i - 1]!, part.coords[i]!);
  }
  return total;
}

export type VertexKind = 'point' | 'endpoint' | 'vertex';

/** Información de un vértice para mostrarla en una tabla. Las coordenadas están en WGS84. */
export interface VertexRow {
  path: VertexPath;
  /** Parte de la geometría a la que pertenece ('' si solo hay una): «Línea 2», «Exterior», «Hueco 1»… */
  part: string;
  /** Posición dentro de su parte (empieza en 1). */
  index: number;
  coord: Position;
  kind: VertexKind;
  /** Distancia horizontal al vértice anterior de la misma parte (m); `null` en el primero. */
  dist: number | null;
  /** Distancia horizontal acumulada desde el primer vértice de su parte (m). */
  cum: number;
  /** Hay un segmento a continuación (se puede insertar un vértice después de este). */
  hasNext: boolean;
}

function partLabel(geometry: Geometry, prefix: number[]): string {
  switch (geometry.type) {
    case 'MultiLineString':
      return `Línea ${prefix[0]! + 1}`;
    case 'Polygon':
      return prefix[0] === 0 ? (geometry.coordinates.length > 1 ? 'Exterior' : '') : `Hueco ${prefix[0]}`;
    case 'MultiPolygon': {
      const poly = geometry.coordinates[prefix[0]!]!;
      const ring = prefix[1] === 0 ? 'Exterior' : `Hueco ${prefix[1]}`;
      return geometry.coordinates.length > 1 ? `Polígono ${prefix[0]! + 1} · ${ring}` : poly.length > 1 ? ring : '';
    }
    default:
      return '';
  }
}

/**
 * Describe los vértices editables de una geometría, uno por fila y en orden: ruta, parte, posición,
 * tipo y distancias. En anillos no se repite el vértice de cierre.
 */
export function describeVertices(geometry: Geometry | null): VertexRow[] {
  if (!geometry) return [];
  const vertices = getVertices(geometry);
  const isPoints = geometry.type === 'Point' || geometry.type === 'MultiPoint';
  const closed = geometry.type === 'Polygon' || geometry.type === 'MultiPolygon';

  // Agrupar por parte (la ruta sin su último elemento)
  const groups = new Map<string, number>();
  for (const v of vertices) {
    const key = v.path.slice(0, -1).join(',');
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }

  const rows: VertexRow[] = [];
  let prev: Position | null = null;
  let prevKey = '';
  let cum = 0;
  for (const v of vertices) {
    const prefix = isPoints ? [] : v.path.slice(0, -1);
    const key = prefix.join(',');
    const index = isPoints ? (geometry.type === 'MultiPoint' ? v.path[0]! + 1 : 1) : v.path[v.path.length - 1]! + 1;
    const first = key !== prevKey || prev === null;
    const dist = first || isPoints ? null : haversine(prev!, v.coord);
    cum = first || isPoints ? 0 : cum + (dist ?? 0);
    rows.push({
      path: v.path,
      part: isPoints ? '' : partLabel(geometry, prefix),
      index,
      coord: v.coord,
      kind: isPoints ? 'point' : v.isEndpoint ? 'endpoint' : 'vertex',
      dist,
      cum,
      hasNext: !isPoints && (closed || index < (groups.get(key) ?? 0)),
    });
    prev = v.coord;
    prevKey = key;
  }
  return rows;
}
