import { fillMissingZ, resolveGeometryZ } from '../src/geom/coords.js';

describe('fillMissingZ', () => {
  it('línea: continúa a la cota del vértice anterior', () => {
    const g = fillMissingZ({ type: 'LineString', coordinates: [[0, 0, 650], [1, 1], [2, 2]] }, 0);
    expect(g).toEqual({ type: 'LineString', coordinates: [[0, 0, 650], [1, 1, 650], [2, 2, 650]] });
  });

  it('línea: los vértices iniciales toman la cota del primero que la tiene', () => {
    const g = fillMissingZ({ type: 'LineString', coordinates: [[0, 0], [1, 1], [2, 2, 651]] }, 0);
    expect(g).toEqual({ type: 'LineString', coordinates: [[0, 0, 651], [1, 1, 651], [2, 2, 651]] });
  });

  it('sin ninguna Z usa la Z por defecto', () => {
    expect(fillMissingZ({ type: 'LineString', coordinates: [[0, 0], [1, 1]] }, 12)).toEqual({ type: 'LineString', coordinates: [[0, 0, 12], [1, 1, 12]] });
    expect(fillMissingZ({ type: 'Point', coordinates: [0, 0] }, 7)).toEqual({ type: 'Point', coordinates: [0, 0, 7] });
  });

  it('anillo: el cierre repite el primer vértice', () => {
    const g = fillMissingZ({ type: 'Polygon', coordinates: [[[0, 0, 5], [1, 0], [1, 1], [0, 0, 5]]] }, 0) as { coordinates: number[][][] };
    expect(g.coordinates[0]).toEqual([[0, 0, 5], [1, 0, 5], [1, 1, 5], [0, 0, 5]]);
  });

  it('no modifica la geometría original', () => {
    const src = { type: 'LineString' as const, coordinates: [[0, 0, 1], [1, 1]] };
    fillMissingZ(src, 0);
    expect(src.coordinates[1]).toEqual([1, 1]);
  });
});

describe('resolveGeometryZ', () => {
  const mixed = { type: 'LineString' as const, coordinates: [[0, 0, 650], [1, 1]] };

  it('capa 3D: completa la Z', () => {
    const r = resolveGeometryZ(mixed, { hasZ: true, memory: false, defaultZ: 0 });
    expect(r).toMatchObject({ promote: false, stripped: false });
    expect(r.geometry).toEqual({ type: 'LineString', coordinates: [[0, 0, 650], [1, 1, 650]] });
  });

  it('capa nueva 2D con Z del snap: pasa a 3D', () => {
    const r = resolveGeometryZ(mixed, { hasZ: false, memory: true, defaultZ: 0 });
    expect(r.promote).toBe(true);
    expect(r.geometry).toEqual({ type: 'LineString', coordinates: [[0, 0, 650], [1, 1, 650]] });
  });

  it('capa 2D de fichero: descarta la Z', () => {
    const r = resolveGeometryZ(mixed, { hasZ: false, memory: false, defaultZ: 0 });
    expect(r.stripped).toBe(true);
    expect(r.geometry).toEqual({ type: 'LineString', coordinates: [[0, 0], [1, 1]] });
  });

  it('geometría 2D en capa 2D: no cambia nada', () => {
    const g = { type: 'Point' as const, coordinates: [0, 0] };
    expect(resolveGeometryZ(g, { hasZ: false, memory: true, defaultZ: 0 })).toEqual({ geometry: g, promote: false, stripped: false });
  });
});
