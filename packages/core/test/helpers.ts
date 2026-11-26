import type { Position } from 'geojson';
import type { Projector } from '../src/types.js';

/** Proyector lineal sencillo: 1 grado = `scale` píxeles (suficiente para probar snapping). */
export function linearProjector(scale = 1000, origin: Position = [0, 0]): Projector {
  return {
    project: (c) => ({ x: (c[0]! - origin[0]!) * scale, y: -(c[1]! - origin[1]!) * scale }),
    unproject: (p) => [p.x / scale + origin[0]!, -p.y / scale + origin[1]!],
  };
}
