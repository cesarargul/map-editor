import { normalizeSnapConfig } from '../src/snapping/config.js';
import { Snapper } from '../src/snapping/snapper.js';
import type { EditorFeature } from '../src/types.js';
import { linearProjector } from './helpers.js';

const P = linearProjector(1000); // 0.001° = 1 px

function feat(id: string, geometry: EditorFeature['geometry']): EditorFeature {
  return { id, geometry, properties: {}, status: 'original' };
}

function setup(cfg = {}) {
  const snapper = new Snapper(normalizeSnapConfig({ tolerancePx: 10, ...cfg }));
  snapper.indexLayer('tuberias', [
    feat('t1', { type: 'LineString', coordinates: [[0, 0, 100], [0.1, 0, 110]] }),
  ]);
  snapper.indexLayer('calles', [
    feat('c1', { type: 'LineString', coordinates: [[0.05, -0.05, 50], [0.05, 0.05, 50]] }),
  ]);
  snapper.indexLayer('parcelas', [
    feat('p1', { type: 'Polygon', coordinates: [[[1, 1], [1.1, 1], [1.1, 1.1], [1, 1.1], [1, 1]]] }),
  ]);
  return snapper;
}

const query = (x: number, y: number, editingLayerId: string | null = 'tuberias') => ({
  point: P.project([x, y]),
  projector: P,
  editingLayerId,
  availableLayerIds: ['tuberias', 'calles', 'parcelas'],
});

describe('Snapper', () => {
  it('engancha a extremo y hereda su Z', () => {
    const r = setup().snap(query(0.003, 0.002))!;
    expect(r.type).toBe('endpoint');
    expect(r.coord).toEqual([0, 0, 100]);
    expect(r.layerId).toBe('tuberias');
  });

  it('engancha a arista e interpola la Z', () => {
    const r = setup({ defaultTypes: ['edge'] }).snap(query(0.025, 0.004))!;
    expect(r.type).toBe('edge');
    expect(r.coord[0]).toBeCloseTo(0.025, 6);
    expect(r.coord[1]).toBeCloseTo(0, 6);
    expect(r.coord[2]).toBeCloseTo(102.5, 6);
  });

  it('engancha al punto medio', () => {
    const r = setup({ defaultTypes: ['midpoint'] }).snap(query(0.052, 0.003))!;
    expect(r.type).toBe('midpoint');
    expect(r.coord[2]).toBeCloseTo(105, 6);
  });

  it('detecta intersecciones y avisa si las Z no coinciden (no conectadas en 3D)', () => {
    const r = setup().snap(query(0.051, 0.001))!;
    expect(r.type).toBe('intersection');
    expect(r.coord[0]).toBeCloseTo(0.05, 6);
    expect(r.zConflict).toBe(true);
    expect(r.zValues![0]).toBeCloseTo(105, 6);
    expect(r.zValues![1]).toBeCloseTo(50, 6);
  });

  it('intersección con Z coincidente: sin conflicto', () => {
    const snapper = new Snapper(normalizeSnapConfig({ tolerancePx: 10 }));
    snapper.indexLayer('a', [feat('a1', { type: 'LineString', coordinates: [[0, 0, 7], [0.1, 0, 7]] })]);
    snapper.indexLayer('b', [feat('b1', { type: 'LineString', coordinates: [[0.05, -0.05, 7], [0.05, 0.05, 7]] })]);
    const r = snapper.snap({ point: P.project([0.05, 0.001]), projector: P, editingLayerId: 'a', availableLayerIds: ['a', 'b'] })!;
    expect(r.type).toBe('intersection');
    expect(r.zConflict).toBeUndefined();
  });

  it('respeta la matriz de capas: solo self', () => {
    const snapper = setup({ rules: { tuberias: ['self'] } });
    // Cerca del vértice de la calle pero la regla lo impide
    const r = snapper.snap(query(0.05, -0.049));
    expect(r).toBeNull();
  });

  it('respeta los tipos por capa destino', () => {
    const snapper = setup({ targets: { parcelas: { types: ['vertex'] } } });
    expect(snapper.snap(query(1.05, 1.002, 'calles'))).toBeNull(); // arista de parcela no permitida
    expect(snapper.snap(query(1.001, 1.001, 'calles'))!.type).toBe('vertex');
  });

  it('fuera de tolerancia no engancha', () => {
    expect(setup().snap(query(0.5, 0.5))).toBeNull();
  });

  it('excluye el vértice que se arrastra y sus segmentos', () => {
    const snapper = setup();
    const r = snapper.snap({
      ...query(0.001, 0.001),
      excludeVertices: [{ layerId: 'tuberias', featureId: 't1', path: [0] }],
    });
    expect(r).toBeNull();
  });

  it('actualiza el índice de forma incremental', () => {
    const snapper = setup();
    snapper.updateFeatures('tuberias', [{ id: 't1', feature: null }]);
    expect(snapper.snap(query(0.001, 0.001, 'calles'))).toBeNull();
    snapper.updateFeatures('tuberias', [{ id: 't2', feature: feat('t2', { type: 'Point', coordinates: [0.3, 0.3, 5] }) }]);
    expect(snapper.snap(query(0.301, 0.3, 'calles'))!.coord).toEqual([0.3, 0.3, 5]);
  });

  it('desactivado no engancha', () => {
    expect(setup({ enabled: false }).snap(query(0, 0))).toBeNull();
  });
});
