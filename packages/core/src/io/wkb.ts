import type { Geometry, Position } from 'geojson';

/**
 * Lector/escritor WKB (ISO y EWKB) con soporte de Z. Se usa en GeoPackage.
 * Las coordenadas M se leen y se descartan.
 */

const TYPES = ['', 'Point', 'LineString', 'Polygon', 'MultiPoint', 'MultiLineString', 'MultiPolygon', 'GeometryCollection'] as const;

export function readWkb(bytes: Uint8Array, offset = 0): { geometry: Geometry; offset: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = offset;

  function read(): Geometry {
    const le = view.getUint8(o) === 1;
    o += 1;
    let type = view.getUint32(o, le);
    o += 4;
    let hasZ = false;
    let hasM = false;
    // EWKB
    if (type & 0x80000000) hasZ = true;
    if (type & 0x40000000) hasM = true;
    if (type & 0x20000000) o += 4; // SRID
    type &= 0x0fffffff;
    // ISO
    if (type >= 3000) {
      hasZ = true;
      hasM = true;
      type -= 3000;
    } else if (type >= 2000) {
      hasM = true;
      type -= 2000;
    } else if (type >= 1000) {
      hasZ = true;
      type -= 1000;
    }
    const dims = 2 + (hasZ ? 1 : 0) + (hasM ? 1 : 0);

    const pt = (): Position => {
      const x = view.getFloat64(o, le);
      const y = view.getFloat64(o + 8, le);
      const z = hasZ ? view.getFloat64(o + 16, le) : undefined;
      o += dims * 8;
      return z === undefined ? [x, y] : [x, y, z];
    };
    const u32 = () => {
      const v = view.getUint32(o, le);
      o += 4;
      return v;
    };
    const line = (): Position[] => Array.from({ length: u32() }, pt);
    const poly = (): Position[][] => Array.from({ length: u32() }, line);

    switch (TYPES[type]) {
      case 'Point':
        return { type: 'Point', coordinates: pt() };
      case 'LineString':
        return { type: 'LineString', coordinates: line() };
      case 'Polygon':
        return { type: 'Polygon', coordinates: poly() };
      case 'MultiPoint':
        return { type: 'MultiPoint', coordinates: Array.from({ length: u32() }, () => (read() as { coordinates: Position }).coordinates) };
      case 'MultiLineString':
        return { type: 'MultiLineString', coordinates: Array.from({ length: u32() }, () => (read() as { coordinates: Position[] }).coordinates) };
      case 'MultiPolygon':
        return { type: 'MultiPolygon', coordinates: Array.from({ length: u32() }, () => (read() as { coordinates: Position[][] }).coordinates) };
      case 'GeometryCollection':
        return { type: 'GeometryCollection', geometries: Array.from({ length: u32() }, read) };
      default:
        throw new Error(`Tipo WKB no soportado: ${type}`);
    }
  }

  const geometry = read();
  return { geometry, offset: o };
}

/** Escribe WKB ISO little-endian. Con `withZ` se escriben 3 dimensiones (Z=0 si falta). */
export function writeWkb(geometry: Geometry, withZ: boolean): Uint8Array {
  const chunks: number[] = [];
  const buf = new ArrayBuffer(8);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const pushU32 = (v: number) => {
    dv.setUint32(0, v, true);
    for (let i = 0; i < 4; i++) chunks.push(u8[i]!);
  };
  const pushF64 = (v: number) => {
    dv.setFloat64(0, v, true);
    for (let i = 0; i < 8; i++) chunks.push(u8[i]!);
  };
  const pt = (c: Position) => {
    pushF64(c[0]!);
    pushF64(c[1]!);
    if (withZ) pushF64(c[2] ?? 0);
  };
  const header = (t: number) => {
    chunks.push(1);
    pushU32(withZ ? t + 1000 : t);
  };
  const line = (cs: Position[]) => {
    pushU32(cs.length);
    cs.forEach(pt);
  };
  const write = (g: Geometry) => {
    switch (g.type) {
      case 'Point':
        header(1);
        if (g.coordinates.length === 0) {
          pushF64(NaN);
          pushF64(NaN);
          if (withZ) pushF64(NaN);
        } else pt(g.coordinates);
        break;
      case 'LineString':
        header(2);
        line(g.coordinates);
        break;
      case 'Polygon':
        header(3);
        pushU32(g.coordinates.length);
        g.coordinates.forEach(line);
        break;
      case 'MultiPoint':
        header(4);
        pushU32(g.coordinates.length);
        g.coordinates.forEach((c) => write({ type: 'Point', coordinates: c }));
        break;
      case 'MultiLineString':
        header(5);
        pushU32(g.coordinates.length);
        g.coordinates.forEach((c) => write({ type: 'LineString', coordinates: c }));
        break;
      case 'MultiPolygon':
        header(6);
        pushU32(g.coordinates.length);
        g.coordinates.forEach((c) => write({ type: 'Polygon', coordinates: c }));
        break;
      case 'GeometryCollection':
        header(7);
        pushU32(g.geometries.length);
        g.geometries.forEach(write);
        break;
    }
  };
  write(geometry);
  return Uint8Array.from(chunks);
}
