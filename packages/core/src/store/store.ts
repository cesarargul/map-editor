import type { Geometry } from 'geojson';
import { inferGeometryKind } from '../geom/coords.js';
import type {
  ChangeSummary,
  EditorFeature,
  FieldDef,
  FieldType,
  LayerInfo,
  LayerSource,
  LayerStyle,
} from '../types.js';
import { Emitter } from '../util/emitter.js';
import { clone, uid } from '../util/id.js';

export interface FeatureChange {
  layerId: string;
  featureId: string;
  before: EditorFeature | null;
  after: EditorFeature | null;
}

export interface FieldsChange {
  layerId: string;
  before: FieldDef[];
  after: FieldDef[];
}

export interface HistoryEntry {
  label: string;
  features: FeatureChange[];
  fields: FieldsChange[];
  timestamp: number;
}

export interface StoreEvents extends Record<string, unknown> {
  'layer-added': { layer: LayerInfo };
  'layer-removed': { layerId: string };
  'layer-updated': { layer: LayerInfo };
  'layers-reordered': { order: string[] };
  /** Entidades cambiadas (añadidas, modificadas, borradas o restauradas). */
  'features-changed': { layerId: string; featureIds: string[]; reason: 'edit' | 'undo' | 'redo' | 'load' };
  'history-changed': { canUndo: boolean; canRedo: boolean; undoLabel?: string; redoLabel?: string };
}

const PALETTE = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#9a6324', '#469990', '#000075'];
let paletteIndex = 0;

export function defaultStyle(): LayerStyle {
  const color = PALETTE[paletteIndex++ % PALETTE.length]!;
  return { color, fillOpacity: 0.25, lineWidth: 2.5, pointRadius: 5 };
}

export interface NewLayerInput {
  id?: string;
  name: string;
  source: LayerSource;
  features?: Array<{ geometry: Geometry | null; properties?: Record<string, unknown> | null; id?: string | number; status?: EditorFeature['status']; internalId?: string }>;
  fields?: FieldDef[];
  style?: Partial<LayerStyle>;
  visible?: boolean;
  editable?: boolean;
  geometryKind?: LayerInfo['geometryKind'];
  defaultZ?: number;
}

class LayerData {
  features = new Map<string, EditorFeature>();
  constructor(public info: LayerInfo) {}
}

/**
 * Transacción de edición: agrupa cambios en una única entrada del historial.
 * Las lecturas devuelven copias; las escrituras se hacen con los métodos de la transacción.
 */
export class Transaction {
  /** @internal */ readonly featureChanges = new Map<string, FeatureChange>();
  /** @internal */ readonly fieldChanges = new Map<string, FieldsChange>();

  constructor(private readonly store: FeatureStore) {}

  private key(layerId: string, featureId: string): string {
    return `${layerId}\u0000${featureId}`;
  }

  private track(layerId: string, featureId: string): void {
    const key = this.key(layerId, featureId);
    if (!this.featureChanges.has(key)) {
      const current = this.store.getFeature(layerId, featureId);
      this.featureChanges.set(key, { layerId, featureId, before: current, after: null });
    }
  }

  /** Añade una entidad nueva. Devuelve su id. */
  add(layerId: string, geometry: Geometry | null, properties: Record<string, unknown> = {}): string {
    const layer = this.store._layer(layerId);
    const id = uid('f');
    this.track(layerId, id);
    layer.features.set(id, { id, geometry: clone(geometry), properties: { ...properties }, status: 'new' });
    return id;
  }

  /** Inserta una entidad ya construida (p. ej. pegar). */
  put(layerId: string, feature: EditorFeature): void {
    const layer = this.store._layer(layerId);
    this.track(layerId, feature.id);
    layer.features.set(feature.id, clone(feature));
  }

  setGeometry(layerId: string, featureId: string, geometry: Geometry | null): void {
    const f = this.mutable(layerId, featureId);
    if (JSON.stringify(f.geometry) === JSON.stringify(geometry)) return;
    f.geometry = clone(geometry);
    if (f.status === 'original') f.status = 'modified';
  }

  setProperties(layerId: string, featureId: string, properties: Record<string, unknown>, merge = true): void {
    const f = this.mutable(layerId, featureId);
    const next = merge ? { ...f.properties, ...properties } : { ...properties };
    if (JSON.stringify(f.properties) === JSON.stringify(next)) return;
    f.properties = next;
    if (f.status === 'original') f.status = 'modified';
  }

  /** Borra una entidad. Las nuevas desaparecen; las del fichero quedan marcadas como borradas. */
  delete(layerId: string, featureId: string): void {
    const layer = this.store._layer(layerId);
    const f = layer.features.get(featureId);
    if (!f || f.status === 'deleted') return;
    this.track(layerId, featureId);
    if (f.status === 'new') layer.features.delete(featureId);
    else f.status = 'deleted';
  }

  setFields(layerId: string, fields: FieldDef[]): void {
    const layer = this.store._layer(layerId);
    if (!this.fieldChanges.has(layerId)) {
      this.fieldChanges.set(layerId, { layerId, before: clone(layer.info.fields), after: [] });
    }
    layer.info.fields = clone(fields);
  }

  private mutable(layerId: string, featureId: string): EditorFeature {
    const layer = this.store._layer(layerId);
    const f = layer.features.get(featureId);
    if (!f || f.status === 'deleted') throw new Error(`La entidad ${featureId} no existe en la capa ${layerId}`);
    this.track(layerId, featureId);
    return f;
  }
}

/**
 * Almacén de capas vectoriales con seguimiento de cambios e historial (deshacer/rehacer).
 * No depende de MapLibre: se puede usar y probar de forma aislada.
 */
export class FeatureStore {
  readonly events = new Emitter<StoreEvents>();
  private layers = new Map<string, LayerData>();
  private order: string[] = [];
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];

  constructor(public historyLimit = 200) {}

  // --- Capas -----------------------------------------------------------------------------

  addLayer(input: NewLayerInput): LayerInfo {
    const id = input.id ?? uid('l');
    if (this.layers.has(id)) throw new Error(`Ya existe una capa con id ${id}`);
    const features = new Map<string, EditorFeature>();
    for (const f of input.features ?? []) {
      const fid = f.internalId ?? uid('f');
      features.set(fid, {
        id: fid,
        geometry: f.geometry,
        properties: { ...(f.properties ?? {}) },
        status: f.status ?? 'original',
        ...(f.id !== undefined ? { sourceId: f.id } : {}),
      });
    }
    const info: LayerInfo = {
      id,
      name: input.name,
      source: input.source,
      fields: input.fields ?? inferFields([...features.values()].map((f) => f.properties)),
      style: { ...defaultStyle(), ...input.style },
      visible: input.visible ?? true,
      editable: input.editable ?? true,
      geometryKind: input.geometryKind ?? inferGeometryKind([...features.values()].map((f) => f.geometry)),
      defaultZ: input.defaultZ ?? 0,
    };
    const data = new LayerData(info);
    data.features = features;
    this.layers.set(id, data);
    this.order.push(id);
    this.events.emit('layer-added', { layer: clone(info) });
    this.events.emit('features-changed', { layerId: id, featureIds: [...features.keys()], reason: 'load' });
    return clone(info);
  }

  removeLayer(layerId: string): void {
    if (!this.layers.delete(layerId)) return;
    this.order = this.order.filter((id) => id !== layerId);
    // El historial que afecta a la capa eliminada deja de ser aplicable.
    const touches = (e: HistoryEntry) =>
      e.features.some((c) => c.layerId === layerId) || e.fields.some((c) => c.layerId === layerId);
    this.undoStack = this.undoStack.filter((e) => !touches(e));
    this.redoStack = this.redoStack.filter((e) => !touches(e));
    this.events.emit('layer-removed', { layerId });
    this.emitHistory();
  }

  updateLayer(layerId: string, patch: Partial<Pick<LayerInfo, 'name' | 'style' | 'visible' | 'editable' | 'defaultZ' | 'geometryKind' | 'source'>>): LayerInfo {
    const layer = this._layer(layerId);
    const next = { ...layer.info, ...patch };
    if (patch.style) next.style = { ...layer.info.style, ...patch.style };
    layer.info = next;
    this.events.emit('layer-updated', { layer: clone(next) });
    return clone(next);
  }

  reorderLayers(order: string[]): void {
    const known = order.filter((id) => this.layers.has(id));
    const rest = this.order.filter((id) => !known.includes(id));
    this.order = [...known, ...rest];
    this.events.emit('layers-reordered', { order: [...this.order] });
  }

  hasLayer(layerId: string): boolean {
    return this.layers.has(layerId);
  }

  getLayer(layerId: string): LayerInfo | null {
    const l = this.layers.get(layerId);
    return l ? clone(l.info) : null;
  }

  /** Capas en orden de dibujo (la primera, abajo). */
  getLayers(): LayerInfo[] {
    return this.order.map((id) => clone(this.layers.get(id)!.info));
  }

  // --- Entidades -------------------------------------------------------------------------

  getFeature(layerId: string, featureId: string): EditorFeature | null {
    const f = this.layers.get(layerId)?.features.get(featureId);
    return f ? clone(f) : null;
  }

  /**
   * Entidades de la capa. Por defecto excluye las borradas.
   * Devuelve referencias de solo lectura (no modificar): para editar usar `transact`.
   */
  getFeatures(layerId: string, opts: { includeDeleted?: boolean } = {}): readonly Readonly<EditorFeature>[] {
    const layer = this.layers.get(layerId);
    if (!layer) return [];
    const out: EditorFeature[] = [];
    for (const f of layer.features.values()) {
      if (opts.includeDeleted || f.status !== 'deleted') out.push(f);
    }
    return out;
  }

  featureCount(layerId: string): number {
    let n = 0;
    for (const f of this.layers.get(layerId)?.features.values() ?? []) if (f.status !== 'deleted') n++;
    return n;
  }

  changeSummary(layerId: string): ChangeSummary {
    const s: ChangeSummary = { new: 0, modified: 0, deleted: 0 };
    for (const f of this.layers.get(layerId)?.features.values() ?? []) {
      if (f.status !== 'original') s[f.status]++;
    }
    return s;
  }

  /** Marca todas las entidades como originales (p. ej. tras guardar en el servidor). */
  commitChanges(layerId: string): void {
    const layer = this._layer(layerId);
    const ids: string[] = [];
    for (const [id, f] of layer.features) {
      if (f.status === 'deleted') layer.features.delete(id);
      else if (f.status !== 'original') f.status = 'original';
      else continue;
      ids.push(id);
    }
    this.events.emit('features-changed', { layerId, featureIds: ids, reason: 'load' });
  }

  // --- Transacciones e historial ---------------------------------------------------------

  /** Ejecuta una edición como una única entrada de historial. */
  transact<T>(label: string, fn: (tx: Transaction) => T): T {
    const tx = new Transaction(this);
    let result: T;
    try {
      result = fn(tx);
    } catch (err) {
      this.rollback(tx);
      throw err;
    }
    const entry = this.finish(label, tx);
    if (entry) {
      this.undoStack.push(entry);
      if (this.undoStack.length > this.historyLimit) this.undoStack.shift();
      this.redoStack = [];
      this.emitChanges(entry, 'edit');
      this.emitHistory();
    }
    return result;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): HistoryEntry | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.applyEntry(entry, 'before');
    this.redoStack.push(entry);
    this.emitChanges(entry, 'undo');
    this.emitHistory();
    return entry;
  }

  redo(): HistoryEntry | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.applyEntry(entry, 'after');
    this.undoStack.push(entry);
    this.emitChanges(entry, 'redo');
    this.emitHistory();
    return entry;
  }

  clearHistory(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.emitHistory();
  }

  /** Historial serializable (para el autoguardado). */
  exportHistory(limit = 50): { undo: HistoryEntry[]; redo: HistoryEntry[] } {
    return { undo: clone(this.undoStack.slice(-limit)), redo: clone(this.redoStack.slice(-limit)) };
  }

  importHistory(h: { undo: HistoryEntry[]; redo: HistoryEntry[] }): void {
    const valid = (e: HistoryEntry) =>
      e.features.every((c) => this.layers.has(c.layerId)) && e.fields.every((c) => this.layers.has(c.layerId));
    this.undoStack = h.undo.filter(valid);
    this.redoStack = h.redo.filter(valid);
    this.emitHistory();
  }

  /** @internal */
  _layer(layerId: string): LayerData {
    const l = this.layers.get(layerId);
    if (!l) throw new Error(`No existe la capa ${layerId}`);
    return l;
  }

  private finish(label: string, tx: Transaction): HistoryEntry | null {
    const features: FeatureChange[] = [];
    for (const c of tx.featureChanges.values()) {
      const after = this.getFeature(c.layerId, c.featureId);
      if (JSON.stringify(c.before) === JSON.stringify(after)) continue;
      features.push({ ...c, after });
    }
    const fields: FieldsChange[] = [];
    for (const c of tx.fieldChanges.values()) {
      const after = clone(this._layer(c.layerId).info.fields);
      if (JSON.stringify(c.before) === JSON.stringify(after)) continue;
      fields.push({ ...c, after });
    }
    if (features.length === 0 && fields.length === 0) return null;
    return { label, features, fields, timestamp: Date.now() };
  }

  private rollback(tx: Transaction): void {
    for (const c of tx.featureChanges.values()) this.writeFeature(c.layerId, c.featureId, c.before);
    for (const c of tx.fieldChanges.values()) this._layer(c.layerId).info.fields = c.before;
  }

  private applyEntry(entry: HistoryEntry, side: 'before' | 'after'): void {
    for (const c of entry.features) this.writeFeature(c.layerId, c.featureId, c[side]);
    for (const c of entry.fields) {
      const layer = this._layer(c.layerId);
      layer.info.fields = clone(c[side]);
      this.events.emit('layer-updated', { layer: clone(layer.info) });
    }
  }

  private writeFeature(layerId: string, featureId: string, value: EditorFeature | null): void {
    const layer = this.layers.get(layerId);
    if (!layer) return;
    if (value) layer.features.set(featureId, clone(value));
    else layer.features.delete(featureId);
  }

  private emitChanges(entry: HistoryEntry, reason: 'edit' | 'undo' | 'redo'): void {
    const byLayer = new Map<string, string[]>();
    for (const c of entry.features) {
      const list = byLayer.get(c.layerId) ?? [];
      list.push(c.featureId);
      byLayer.set(c.layerId, list);
    }
    for (const [layerId, featureIds] of byLayer) this.events.emit('features-changed', { layerId, featureIds, reason });
    for (const c of entry.fields) {
      if (!byLayer.has(c.layerId)) this.events.emit('features-changed', { layerId: c.layerId, featureIds: [], reason });
    }
  }

  private emitHistory(): void {
    this.events.emit('history-changed', {
      canUndo: this.canUndo(),
      canRedo: this.canRedo(),
      ...(this.undoStack.length ? { undoLabel: this.undoStack[this.undoStack.length - 1]!.label } : {}),
      ...(this.redoStack.length ? { redoLabel: this.redoStack[this.redoStack.length - 1]!.label } : {}),
    });
  }
}

/** Deduce el esquema de atributos a partir de los valores. */
export function inferFields(rows: Iterable<Record<string, unknown>>): FieldDef[] {
  const types = new Map<string, FieldType | null>();
  for (const row of rows) {
    for (const [k, v] of Object.entries(row)) {
      if (v === null || v === undefined || v === '') {
        if (!types.has(k)) types.set(k, null);
        continue;
      }
      const t = valueType(v);
      const prev = types.get(k);
      if (prev === undefined || prev === null) types.set(k, t);
      else if (prev !== t) types.set(k, mergeTypes(prev, t));
    }
  }
  return [...types].map(([name, type]) => ({ name, type: type ?? 'string' }));
}

function valueType(v: unknown): FieldType {
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  if (v instanceof Date) return 'date';
  return 'string';
}

function mergeTypes(a: FieldType, b: FieldType): FieldType {
  if ((a === 'integer' && b === 'number') || (a === 'number' && b === 'integer')) return 'number';
  return 'string';
}
