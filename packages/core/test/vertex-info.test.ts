import { describeVertices, haversine, lengthM } from '../src/geom/vertex-info.js';

describe('haversine / lengthM', () => {
  it('0,001° de longitud en el ecuador son ~111,19 m', () => {
    expect(haversine([0, 0], [0.001, 0])).toBeCloseTo(111.19, 1);
  });

  it('suma los tramos de líneas y el perímetro (incluido el cierre) de polígonos', () => {
    expect(lengthM({ type: 'LineString', coordinates: [[0, 0], [0.001, 0], [0.001, 0.001]] })).toBeCloseTo(222.39, 1);
    const square = { type: 'Polygon' as const, coordinates: [[[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001], [0, 0]]] };
    expect(lengthM(square)).toBeCloseTo(444.78, 1);
    expect(lengthM({ type: 'Point', coordinates: [0, 0] })).toBe(0);
    expect(lengthM(null)).toBe(0);
  });
});

describe('describeVertices', () => {
  it('línea: índices, extremos y distancias', () => {
    const rows = describeVertices({ type: 'LineString', coordinates: [[0, 0, 10], [0.001, 0, 11], [0.002, 0, 12]] });
    expect(rows.map((r) => [r.index, r.kind, r.hasNext])).toEqual([[1, 'endpoint', true], [2, 'vertex', true], [3, 'endpoint', false]]);
    expect(rows[0]!.dist).toBeNull();
    expect(rows[1]!.dist).toBeCloseTo(111.19, 1);
    expect(rows[2]!.cum).toBeCloseTo(222.39, 1);
    expect(rows[1]!.coord).toEqual([0.001, 0, 11]);
    expect(rows.every((r) => r.part === '')).toBe(true);
  });

  it('polígono con hueco: partes, sin repetir el cierre y se puede insertar tras el último', () => {
    const ring = (o: number) => [[o, o], [o + 3, o], [o + 3, o + 3], [o, o + 3], [o, o]];
    const rows = describeVertices({ type: 'Polygon', coordinates: [ring(0), ring(1).reverse()] });
    expect(rows).toHaveLength(8);
    expect(rows.slice(0, 4).every((r) => r.part === 'Exterior')).toBe(true);
    expect(rows.slice(4).every((r) => r.part === 'Hueco 1')).toBe(true);
    expect(rows[4]!.index).toBe(1);
    expect(rows[4]!.dist).toBeNull(); // la distancia se reinicia en cada anillo
    expect(rows.every((r) => r.kind === 'vertex' && r.hasNext)).toBe(true);
  });

  it('polígono simple no etiqueta la parte; multipolígono y multilínea sí', () => {
    const sq = [[0, 0], [1, 0], [1, 1], [0, 0]];
    expect(describeVertices({ type: 'Polygon', coordinates: [sq] }).every((r) => r.part === '')).toBe(true);
    const mp = describeVertices({ type: 'MultiPolygon', coordinates: [[sq], [sq]] });
    expect([...new Set(mp.map((r) => r.part))]).toEqual(['Polígono 1 · Exterior', 'Polígono 2 · Exterior']);
    const ml = describeVertices({ type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]], [[2, 2], [3, 3]]] });
    expect(ml.map((r) => [r.part, r.index, r.kind])).toEqual([['Línea 1', 1, 'endpoint'], ['Línea 1', 2, 'endpoint'], ['Línea 2', 1, 'endpoint'], ['Línea 2', 2, 'endpoint']]);
    expect(ml[2]!.dist).toBeNull();
  });

  it('puntos: sin distancias ni inserción', () => {
    expect(describeVertices({ type: 'Point', coordinates: [1, 2, 3] })).toMatchObject([{ kind: 'point', index: 1, hasNext: false, dist: null }]);
    const mp = describeVertices({ type: 'MultiPoint', coordinates: [[0, 0], [1, 1]] });
    expect(mp.map((r) => r.index)).toEqual([1, 2]);
    expect(mp.every((r) => r.kind === 'point' && !r.hasNext)).toBe(true);
  });

  it('geometría nula: sin filas', () => {
    expect(describeVertices(null)).toEqual([]);
  });
});
