import { FeatureStore, inferFields } from '../src/store/store.js';

const src = { format: 'geojson' as const, crs: 'EPSG:4326', hasZ: false };

function setup() {
  const store = new FeatureStore();
  const layer = store.addLayer({
    name: 'Calles',
    source: src,
    features: [
      { geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] }, properties: { nombre: 'A', carriles: 2 } },
      { geometry: { type: 'LineString', coordinates: [[1, 1], [2, 0]] }, properties: { nombre: 'B', carriles: 1 } },
    ],
  });
  return { store, layer };
}

describe('FeatureStore', () => {
  it('infiere tipo de geometría y esquema', () => {
    const { layer } = setup();
    expect(layer.geometryKind).toBe('LineString');
    expect(layer.fields).toEqual([
      { name: 'nombre', type: 'string' },
      { name: 'carriles', type: 'integer' },
    ]);
  });

  it('rastrea estados nuevo/modificado/borrado', () => {
    const { store, layer } = setup();
    const [a, b] = store.getFeatures(layer.id);
    store.transact('editar', (tx) => {
      tx.setProperties(layer.id, a!.id, { nombre: 'A2' });
      tx.delete(layer.id, b!.id);
      tx.add(layer.id, { type: 'Point', coordinates: [5, 5] }, { nombre: 'C' });
    });
    expect(store.changeSummary(layer.id)).toEqual({ new: 1, modified: 1, deleted: 1 });
    expect(store.featureCount(layer.id)).toBe(2);
    expect(store.getFeatures(layer.id, { includeDeleted: true })).toHaveLength(3);
  });

  it('deshace y rehace transacciones completas', () => {
    const { store, layer } = setup();
    const [a] = store.getFeatures(layer.id);
    store.transact('mover', (tx) => tx.setGeometry(layer.id, a!.id, { type: 'LineString', coordinates: [[0, 0], [3, 3]] }));
    store.transact('añadir', (tx) => tx.add(layer.id, { type: 'LineString', coordinates: [[9, 9], [8, 8]] }));
    expect(store.featureCount(layer.id)).toBe(3);

    store.undo();
    expect(store.featureCount(layer.id)).toBe(2);
    store.undo();
    expect(store.getFeature(layer.id, a!.id)!.geometry).toEqual({ type: 'LineString', coordinates: [[0, 0], [1, 1]] });
    expect(store.getFeature(layer.id, a!.id)!.status).toBe('original');
    expect(store.canUndo()).toBe(false);

    store.redo();
    store.redo();
    expect(store.featureCount(layer.id)).toBe(3);
    expect(store.getFeature(layer.id, a!.id)!.status).toBe('modified');
  });

  it('borrar una entidad nueva la elimina del todo y se puede deshacer', () => {
    const { store, layer } = setup();
    const id = store.transact('añadir', (tx) => tx.add(layer.id, { type: 'Point', coordinates: [1, 2] }));
    store.transact('borrar', (tx) => tx.delete(layer.id, id));
    expect(store.getFeature(layer.id, id)).toBeNull();
    store.undo();
    expect(store.getFeature(layer.id, id)!.status).toBe('new');
  });

  it('las transacciones sin cambios no crean entrada', () => {
    const { store, layer } = setup();
    const [a] = store.getFeatures(layer.id);
    store.transact('nada', (tx) => tx.setProperties(layer.id, a!.id, { nombre: 'A' }));
    expect(store.canUndo()).toBe(false);
  });

  it('revierte la transacción si lanza un error', () => {
    const { store, layer } = setup();
    const [a] = store.getFeatures(layer.id);
    expect(() =>
      store.transact('fallo', (tx) => {
        tx.setProperties(layer.id, a!.id, { nombre: 'X' });
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(store.getFeature(layer.id, a!.id)!.properties['nombre']).toBe('A');
  });

  it('cambios de esquema entran en el historial', () => {
    const { store, layer } = setup();
    store.transact('campo', (tx) => tx.setFields(layer.id, [...layer.fields, { name: 'tipo', type: 'string' }]));
    expect(store.getLayer(layer.id)!.fields).toHaveLength(3);
    store.undo();
    expect(store.getLayer(layer.id)!.fields).toHaveLength(2);
  });

  it('inferFields combina enteros y decimales', () => {
    expect(inferFields([{ v: 1 }, { v: 1.5 }, { v: null }])).toEqual([{ name: 'v', type: 'number' }]);
  });
});
