import type { Feature, Geometry, Position } from 'geojson';
import * as maplibregl from 'maplibre-gl';
import { type Map as MlMap, type MapMouseEvent, type MapOptions, type MapTouchEvent, type StyleSpecification } from 'maplibre-gl';
import { bbox, getSegments, getVertices } from './geom/coords.js';
import { memorySource, readFiles, writeLayer, type ExportOptions, type ExportResult, type InputFile, type IoConfig } from './io/index.js';
import { BASEMAP_PREFIX, defaultBasemaps, rasterStyle, type BasemapDef } from './map/basemaps.js';
import { FID, OVERLAY_SOURCE, Renderer, sourceId, toRenderFeature } from './map/renderer.js';
import { Autosaver, IndexedDbSessionStorage, summarize, type AutosaveOptions, type SavedSession, type SessionSummary } from './persistence/autosave.js';
import { normalizeSnapConfig, type SnapConfig } from './snapping/config.js';
import { lerpCoord, Snapper, type SnapResult } from './snapping/snapper.js';
import { FeatureStore, type StoreEvents } from './store/store.js';
import { DrawTool } from './tools/draw.js';
import { MoveTool } from './tools/move.js';
import { SelectTool, sameRef } from './tools/select.js';
import type { EditState, Tool, ToolContext, ToolId, ToolPointerEvent } from './tools/tool.js';
import type { FeatureRef, FieldDef, GeometryKind, LayerInfo, LayerStyle, Projector, ScreenPoint } from './types.js';
import { downloadBlob } from './util/dropzone.js';
import { Emitter } from './util/emitter.js';

export interface MapEditorOptions {
  container: HTMLElement | string;
  /** Mapa base inicial (por defecto `osm`). */
  basemap?: string;
  /** Lista de mapas base (por defecto OSM, OpenFreeMap y los del IGN). */
  basemaps?: BasemapDef[];
  /** URL de teselas OSM (para producción, usar un proveedor propio). */
  osmTileUrl?: string;
  center?: [number, number];
  zoom?: number;
  snapping?: Partial<SnapConfig>;
  /** Autoguardado en IndexedDB. `false` para desactivarlo. */
  autosave?: AutosaveOptions | false;
  io?: IoConfig;
  /** Qué capas se pueden seleccionar con clic: todas las visibles o solo la activa. */
  selectionScope?: 'visible' | 'active';
  /** Atajos de teclado sobre el contenedor del mapa. */
  keyboard?: boolean;
  /** Opciones adicionales para `new maplibregl.Map`. */
  mapOptions?: Partial<MapOptions>;
  /**
   * URL del worker de MapLibre (`maplibre-gl/dist/maplibre-gl-worker.mjs`). Necesaria cuando la
   * aplicación empaqueta MapLibre con un bundler (Vite, Angular CLI, webpack…).
   */
  workerUrl?: string;
}

/** Configura la URL del worker de MapLibre para todos los mapas de la página. */
export function setMapLibreWorkerUrl(url: string): void {
  maplibregl.setWorkerUrl(url);
}

export type MessageLevel = 'info' | 'warning' | 'error';

export interface EditorEvents extends Record<string, unknown> {
  ready: { editor: MapEditor };
  'layers-changed': { layers: LayerInfo[] };
  'active-layer-changed': { layerId: string | null };
  'features-changed': StoreEvents['features-changed'];
  'selection-changed': { selection: FeatureRef[] };
  'tool-changed': { tool: ToolId };
  'history-changed': StoreEvents['history-changed'];
  'basemap-changed': { id: string };
  'snap-config-changed': { config: SnapConfig };
  'pointer-move': { lngLat: Position | null; snap: SnapResult | null };
  message: { level: MessageLevel; text: string };
  'session-recoverable': SessionSummary;
  autosaved: { savedAt: number };
  'files-loaded': { layers: LayerInfo[]; errors: Array<{ file: string; message: string }> };
  'edit-state-changed': EditState;
}

const NEW_LAYER_NAME: Record<Exclude<GeometryKind, 'Mixed'>, string> = {
  Point: 'Nuevos puntos',
  LineString: 'Nuevas líneas',
  Polygon: 'Nuevos polígonos',
};

/**
 * Editor vectorial headless sobre MapLibre. No incluye interfaz: la interfaz (Web Component,
 * Angular o propia) usa esta API y sus eventos.
 */
export class MapEditor {
  readonly events = new Emitter<EditorEvents>();
  readonly store = new FeatureStore();
  readonly map: MlMap;
  readonly ready: Promise<void>;
  readonly basemaps: BasemapDef[];

  private readonly options: MapEditorOptions;
  private readonly snapper: Snapper;
  private readonly renderer: Renderer;
  private readonly tools: Record<ToolId, Tool>;
  private tool: Tool;
  private selection: FeatureRef[] = [];
  private activeLayer: string | null = null;
  private basemapId: string;
  private hover: FeatureRef | null = null;
  private lastSnap: SnapResult | null = null;
  private pointerDown = false;
  private autosaver: Autosaver | null = null;
  private recoverable: SavedSession | null = null;
  private disposers: Array<() => void> = [];
  private destroyed = false;
  private previewed = new Set<string>();

  constructor(options: MapEditorOptions) {
    this.options = options;
    this.basemaps = options.basemaps ?? defaultBasemaps({ ...(options.osmTileUrl ? { osmTileUrl: options.osmTileUrl } : {}) });
    this.basemapId = this.basemaps.some((b) => b.id === options.basemap) ? options.basemap! : (this.basemaps[0]?.id ?? 'osm');
    this.snapper = new Snapper(normalizeSnapConfig(options.snapping));

    if (options.workerUrl) setMapLibreWorkerUrl(options.workerUrl);
    const container = typeof options.container === 'string' ? document.querySelector<HTMLElement>(options.container) : options.container;
    if (!container) throw new Error('No se encuentra el contenedor del mapa');

    this.map = new maplibregl.Map({
      container,
      style: this.styleFor(this.basemapId),
      center: options.center ?? [-3.7, 40.2],
      zoom: options.zoom ?? 5.3,
      boxZoom: false,
      attributionControl: { compact: true },
      ...options.mapOptions,
    });
    this.map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
    this.map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

    this.coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
    this.renderer = new Renderer(this.map, this.store, this.coarse);
    this.tools = {
      select: new SelectTool(),
      'draw-point': new DrawTool('draw-point'),
      'draw-line': new DrawTool('draw-line'),
      'draw-polygon': new DrawTool('draw-polygon'),
      move: new MoveTool(),
    };
    this.tool = this.tools.select;

    this.bindStore();
    this.ready = new Promise<void>((resolve) => {
      this.map.once('load', async () => {
        this.styleReady = true;
        this.renderer.ensureAll();
        this.bindMap();
        this.tool.activate(this.context);
        await this.initAutosave();
        resolve();
        this.events.emit('ready', { editor: this });
      });
    });
    this.map.on('error', (e) => {
      const err = (e as unknown as { error?: { message?: string } }).error;
      const msg = err?.message ?? '';
      // Errores de teselas del fondo: avisar una sola vez por sesión
      if (/tile|fetch|load|Failed/i.test(msg) && !this.tileErrorShown) {
        this.tileErrorShown = true;
        this.message('warning', 'No se han podido cargar algunas teselas del mapa base.');
      }
    });
  }

  private tileErrorShown = false;
  /** Dispositivo táctil principal (asas y tolerancias más grandes). */
  private readonly coarse: boolean;
  private lastTouchAt = 0;
  /** El estilo está cargado y se pueden añadir fuentes/capas (no confundir con map.loaded(), que espera a las teselas). */
  private styleReady = false;

  // =========================================================================================
  // Capas
  // =========================================================================================

  getLayers(): LayerInfo[] {
    return this.store.getLayers();
  }

  getLayer(id: string): LayerInfo | null {
    return this.store.getLayer(id);
  }

  /** Crea una capa vacía en memoria. */
  createLayer(name: string, geometryKind: GeometryKind, opts: { hasZ?: boolean; fields?: FieldDef[]; style?: Partial<LayerStyle> } = {}): LayerInfo {
    const layer = this.store.addLayer({
      name,
      source: memorySource(opts.hasZ ?? false),
      geometryKind,
      fields: opts.fields ?? [],
      ...(opts.style ? { style: opts.style } : {}),
    });
    this.setActiveLayer(layer.id);
    return layer;
  }

  removeLayer(id: string): void {
    this.setSelection(this.selection.filter((r) => r.layerId !== id));
    this.store.removeLayer(id);
    if (this.activeLayer === id) this.setActiveLayer(this.store.getLayers().at(-1)?.id ?? null);
  }

  updateLayer(id: string, patch: Parameters<FeatureStore['updateLayer']>[1]): LayerInfo {
    return this.store.updateLayer(id, patch);
  }

  setLayerVisible(id: string, visible: boolean): void {
    this.store.updateLayer(id, { visible });
    if (!visible) this.setSelection(this.selection.filter((r) => r.layerId !== id));
  }

  /** Orden de dibujo (la primera, abajo). */
  reorderLayers(order: string[]): void {
    this.store.reorderLayers(order);
  }

  getActiveLayerId(): string | null {
    return this.activeLayer;
  }

  setActiveLayer(id: string | null): void {
    if (id && !this.store.hasLayer(id)) return;
    if (this.activeLayer === id) return;
    this.activeLayer = id;
    this.events.emit('active-layer-changed', { layerId: id });
  }

  zoomToLayer(id: string): void {
    const b = this.layerBounds(id);
    if (b) this.fitBounds(b);
  }

  /** Atributos: modifica las propiedades de una entidad (con deshacer). */
  setFeatureProperties(layerId: string, featureId: string, properties: Record<string, unknown>, merge = true): void {
    this.store.transact('Editar atributos', (tx) => tx.setProperties(layerId, featureId, properties, merge));
  }

  /** Esquema de atributos de la capa (con deshacer). Al renombrar se mueven los valores. */
  setLayerFields(layerId: string, fields: FieldDef[], renames: Record<string, string> = {}): void {
    const layer = this.store.getLayer(layerId);
    if (!layer) return;
    const removed = layer.fields.filter((f) => !fields.some((n) => n.name === f.name) && !renames[f.name]).map((f) => f.name);
    this.store.transact('Editar campos', (tx) => {
      tx.setFields(layerId, fields);
      if (!Object.keys(renames).length && !removed.length) return;
      for (const f of this.store.getFeatures(layerId)) {
        const props = { ...f.properties };
        for (const [from, to] of Object.entries(renames)) {
          if (from in props) {
            props[to] = props[from];
            delete props[from];
          }
        }
        for (const r of removed) delete props[r];
        tx.setProperties(layerId, f.id, props, false);
      }
    });
  }

  // =========================================================================================
  // Ficheros
  // =========================================================================================

  /** Carga ficheros (File del navegador o {name, data}). Devuelve las capas añadidas. */
  async loadFiles(files: Array<File | InputFile>, opts: { zoom?: boolean } = {}): Promise<LayerInfo[]> {
    const inputs: InputFile[] = await Promise.all(
      files.map(async (f) => ('data' in f ? f : { name: (f as File).webkitRelativePath || f.name, data: await (f as File).arrayBuffer() })),
    );
    const { layers, errors } = await readFiles(inputs, this.options.io);
    const added: LayerInfo[] = [];
    for (const l of layers) {
      const info = this.store.addLayer({ name: l.name, source: l.source, features: l.features, ...(l.fields ? { fields: l.fields } : {}) });
      added.push(info);
      for (const w of l.warnings) this.message('warning', `${l.name}: ${w}`);
    }
    for (const e of errors) this.message('error', `${e.file}: ${e.message}`);
    if (added.length) {
      this.setActiveLayer(added.at(-1)!.id);
      this.message('info', added.length === 1 ? `Capa "${added[0]!.name}" cargada (${this.store.featureCount(added[0]!.id)} entidades).` : `${added.length} capas cargadas.`);
      if (opts.zoom !== false) {
        const b = added.map((l) => this.layerBounds(l.id)).reduce<[number, number, number, number] | null>((acc, x) => (!x ? acc : !acc ? x : [Math.min(acc[0], x[0]), Math.min(acc[1], x[1]), Math.max(acc[2], x[2]), Math.max(acc[3], x[3])]), null);
        if (b) this.fitBounds(b);
      }
    }
    this.events.emit('files-loaded', { layers: added, errors });
    return added;
  }

  /** Genera el fichero de una capa (por defecto en su formato y CRS de origen). */
  async exportLayer(layerId: string, options: ExportOptions = {}): Promise<ExportResult> {
    const layer = this.store.getLayer(layerId);
    if (!layer) throw new Error(`No existe la capa ${layerId}`);
    const res = await writeLayer(layer, this.store.getFeatures(layerId, { includeDeleted: true }), options, this.options.io);
    for (const w of res.warnings) this.message('warning', `${layer.name}: ${w}`);
    return res;
  }

  /** Exporta y descarga en el navegador. */
  async downloadLayer(layerId: string, options: ExportOptions = {}): Promise<ExportResult> {
    const res = await this.exportLayer(layerId, options);
    downloadBlob(res.data, res.fileName, res.mimeType);
    return res;
  }

  // =========================================================================================
  // Herramientas, selección e historial
  // =========================================================================================

  getTool(): ToolId {
    return this.tool.id;
  }

  setTool(id: ToolId): void {
    const next = this.tools[id];
    if (!next || next === this.tool) return;
    this.tool.deactivate();
    this.tool = next;
    this.tool.activate(this.context);
    this.lastSnap = null;
    this.updateCursor();
    this.redraw();
    this.events.emit('tool-changed', { tool: id });
    this.emitEditState();
  }

  // --- Acciones de edición (para botones en pantallas táctiles) -------------------------------

  getEditState(): EditState {
    return { tool: this.tool.id, sketchVertices: 0, canFinish: false, activeVertex: false, ...this.tool.editState?.() };
  }

  /** Termina la línea o el polígono en curso. */
  finishSketch(): void {
    if (this.tool instanceof DrawTool) this.tool.finish();
  }

  /** Quita el último vértice de la línea o el polígono en curso. */
  undoSketchVertex(): void {
    if (this.tool instanceof DrawTool) this.tool.removeLast();
  }

  /** Descarta la línea o el polígono en curso. */
  cancelSketch(): void {
    if (this.tool instanceof DrawTool) this.tool.cancel();
  }

  /** Borra el vértice activo (tocado) de la entidad seleccionada. */
  deleteActiveVertex(): void {
    if (this.tool instanceof SelectTool) this.tool.deleteActiveVertex();
  }

  private emitEditState(): void {
    this.events.emit('edit-state-changed', this.getEditState());
  }

  getSelection(): FeatureRef[] {
    return [...this.selection];
  }

  setSelection(refs: FeatureRef[]): void {
    const next = refs.filter((r, i) => this.store.getFeature(r.layerId, r.featureId) && refs.findIndex((x) => sameRef(x, r)) === i);
    const same = next.length === this.selection.length && next.every((r, i) => sameRef(r, this.selection[i]!));
    if (same) return;
    for (const r of this.selection) this.setFeatureState(r, { selected: false });
    this.selection = next;
    for (const r of next) this.setFeatureState(r, { selected: true });
    if (next.length && next.every((r) => r.layerId === next[0]!.layerId)) this.setActiveLayer(next[0]!.layerId);
    this.redraw();
    this.events.emit('selection-changed', { selection: [...next] });
    this.emitEditState();
  }

  deleteSelected(): void {
    const refs = this.selection.filter((r) => this.isEditable(r.layerId));
    if (!refs.length) return;
    this.setSelection([]);
    this.store.transact(refs.length === 1 ? 'Borrar entidad' : `Borrar ${refs.length} entidades`, (tx) => {
      for (const r of refs) tx.delete(r.layerId, r.featureId);
    });
  }

  undo(): void {
    this.store.undo();
  }

  redo(): void {
    this.store.redo();
  }

  canUndo(): boolean {
    return this.store.canUndo();
  }

  canRedo(): boolean {
    return this.store.canRedo();
  }

  // =========================================================================================
  // Snapping y mapa base
  // =========================================================================================

  getSnapConfig(): SnapConfig {
    return structuredClone(this.snapper.config);
  }

  setSnapConfig(config: Partial<SnapConfig>): void {
    this.snapper.config = normalizeSnapConfig({ ...this.snapper.config, ...config });
    this.events.emit('snap-config-changed', { config: this.getSnapConfig() });
  }

  setSnapping(enabled: boolean): void {
    this.setSnapConfig({ enabled });
  }

  getBasemap(): string {
    return this.basemapId;
  }

  setBasemap(id: string): void {
    if (!this.basemaps.some((b) => b.id === id) || id === this.basemapId) return;
    this.basemapId = id;
    this.styleReady = false;
    this.map.once('style.load', () => {
      this.styleReady = true;
      this.renderer.ensureAll();
      for (const l of this.store.getLayers()) this.renderer.reload(l.id);
      for (const r of this.selection) this.setFeatureState(r, { selected: true });
      this.redraw();
    });
    this.map.setStyle(this.styleFor(id), { diff: false });
    this.events.emit('basemap-changed', { id });
  }

  // =========================================================================================
  // Sesión (autoguardado)
  // =========================================================================================

  /** Resumen de la sesión guardada pendiente de recuperar, si la hay. */
  getRecoverableSession(): SessionSummary | null {
    return this.recoverable ? summarize(this.recoverable) : null;
  }

  async restoreSession(): Promise<void> {
    const s = this.recoverable;
    this.recoverable = null;
    if (!s || !this.autosaver) return;
    const idMap = new Map<string, string>();
    for (const l of s.layers) {
      const id = this.store.hasLayer(l.info.id) ? undefined : l.info.id;
      const info = this.store.addLayer({
        ...(id ? { id } : {}),
        name: l.info.name,
        source: l.info.source,
        fields: l.info.fields,
        style: l.info.style,
        visible: l.info.visible,
        editable: l.info.editable,
        geometryKind: l.info.geometryKind,
        defaultZ: l.info.defaultZ,
        features: l.features.map((f) => ({ geometry: f.geometry, properties: f.properties, status: f.status, internalId: f.id, ...(f.sourceId !== undefined ? { id: f.sourceId } : {}) })),
      });
      idMap.set(l.info.id, info.id);
    }
    if (s.history && [...idMap].every(([a, b]) => a === b)) this.store.importHistory(s.history);
    this.setActiveLayer(idMap.get(s.activeLayerId ?? '') ?? this.store.getLayers().at(-1)?.id ?? null);
    this.autosaver.paused = false;
    void this.autosaver.flush();
    this.message('info', 'Sesión anterior recuperada.');
  }

  async discardSession(): Promise<void> {
    this.recoverable = null;
    if (!this.autosaver) return;
    await this.autosaver.clear();
    this.autosaver.paused = false;
    this.autosaver.schedule();
  }

  /** Borra la sesión guardada (p. ej. tras guardar los cambios en el servidor). */
  async clearSavedSession(): Promise<void> {
    await this.autosaver?.clear();
  }

  // =========================================================================================

  message(level: MessageLevel, text: string): void {
    this.events.emit('message', { level, text });
  }

  on<K extends keyof EditorEvents>(type: K, fn: (payload: EditorEvents[K]) => void): () => void {
    return this.events.on(type, fn);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    void this.autosaver?.flush();
    this.autosaver?.dispose();
    this.tool.deactivate();
    this.disposers.forEach((d) => d());
    this.events.removeAllListeners();
    this.store.events.removeAllListeners();
    this.map.remove();
  }

  // =========================================================================================
  // Internos
  // =========================================================================================

  private readonly projector: Projector = {
    project: (c) => {
      const p = this.map.project([c[0]!, c[1]!]);
      return { x: p.x, y: p.y };
    },
    unproject: (p) => this.map.unproject([p.x, p.y]).toArray(),
  };

  private get context(): ToolContext {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      map: this.map,
      store: this.store,
      projector: this.projector,
      activeLayerId: () => self.activeLayer,
      getSelection: () => self.getSelection(),
      setSelection: (r) => self.setSelection(r),
      hitTest: (p, t) => self.hitTest(p, t),
      hitTestBox: (a, b) => self.hitTestBox(a, b),
      hitHandle: (p) => self.hitHandle(p),
      isEditable: (id) => self.isEditable(id),
      drawTarget: (k) => self.drawTarget(k),
      withZ: (c, id) => self.withZ(c, id),
      preview: (l, f, g) => self.preview(l, f, g),
      refresh: (l) => self.refreshPreview(l),
      redraw: () => self.redraw(),
      deleteSelected: () => self.deleteSelected(),
      setTool: (id) => self.setTool(id),
      message: (lvl, t) => self.message(lvl, t),
      stateChanged: () => self.emitEditState(),
    };
  }

  private styleFor(id: string): StyleSpecification | string {
    const def = this.basemaps.find((b) => b.id === id);
    if (!def) return rasterStyle({ id: 'none', name: '', group: '', type: 'raster', layers: [] });
    if (def.type === 'style' && def.style) return def.style;
    return rasterStyle(def);
  }

  private bindStore(): void {
    const s = this.store.events;
    const layersChanged = () => this.events.emit('layers-changed', { layers: this.store.getLayers() });
    s.on('layer-added', ({ layer }) => {
      if (this.styleReady) this.renderer.ensureLayer(layer);
      this.snapper.indexLayer(layer.id, this.store.getFeatures(layer.id));
      layersChanged();
      this.autosaver?.schedule();
    });
    s.on('layer-removed', ({ layerId }) => {
      this.renderer.removeLayer(layerId);
      this.snapper.removeLayer(layerId);
      layersChanged();
      this.autosaver?.schedule();
    });
    s.on('layer-updated', ({ layer }) => {
      if (this.map.getSource(sourceId(layer.id))) this.renderer.applyStyle(layer);
      layersChanged();
      this.autosaver?.schedule();
    });
    s.on('layers-reordered', () => {
      this.renderer.applyOrder();
      layersChanged();
      this.autosaver?.schedule();
    });
    s.on('features-changed', (e) => {
      if (e.reason === 'load') this.renderer.reload(e.layerId);
      else this.renderer.updateFeatures(e.layerId, e.featureIds);
      this.previewed.delete(e.layerId);
      this.snapper.updateFeatures(
        e.layerId,
        e.featureIds.map((id) => ({ id, feature: this.store.getFeature(e.layerId, id) })),
      );
      if (e.reason === 'undo' || e.reason === 'redo') {
        const alive = this.selection.filter((r) => {
          const f = this.store.getFeature(r.layerId, r.featureId);
          return f && f.status !== 'deleted';
        });
        if (alive.length !== this.selection.length) this.setSelection(alive);
      }
      // Refrescar estados de selección (updateData los conserva, pero un setData completo no siempre)
      for (const r of this.selection) if (r.layerId === e.layerId) this.setFeatureState(r, { selected: true });
      this.redraw();
      this.events.emit('features-changed', e);
      if (e.reason !== 'load') this.autosaver?.schedule();
      else this.events.emit('layers-changed', { layers: this.store.getLayers() });
    });
    s.on('history-changed', (e) => this.events.emit('history-changed', e));
  }

  private bindMap(): void {
    const map = this.map;
    const toEvent = (e: MapMouseEvent | MapTouchEvent): ToolPointerEvent => {
      const oe = e.originalEvent as MouseEvent | TouchEvent;
      const point = { x: e.point.x, y: e.point.y };
      const lngLat = e.lngLat.toArray();
      const touch = this.coarse || (typeof TouchEvent !== 'undefined' && oe instanceof TouchEvent) || Date.now() - this.lastTouchAt < 1000;
      const req = this.tool.snapRequest();
      const snap = req
        ? this.snapper.snap({
            point,
            projector: this.projector,
            editingLayerId: req.editingLayerId ?? this.activeLayer,
            availableLayerIds: this.snapLayerIds(),
            ...(req.excludeVertices ? { excludeVertices: req.excludeVertices } : {}),
            ...(req.excludeFeatures ? { excludeFeatures: req.excludeFeatures } : {}),
            ...(touch ? { toleranceScale: 2 } : {}),
          })
        : null;
      return {
        point,
        lngLat,
        coord: snap ? snap.coord : lngLat,
        snap,
        shiftKey: !!oe.shiftKey,
        altKey: !!oe.altKey,
        ctrlKey: !!(oe.ctrlKey || oe.metaKey),
        preventDefault: () => e.preventDefault(),
      };
    };

    const onDown = (e: MapMouseEvent | MapTouchEvent) => {
      if ('button' in e.originalEvent && (e.originalEvent as MouseEvent).button !== 0) return;
      this.pointerDown = true;
      this.map.getCanvas().focus({ preventScroll: true });
      this.tool.onPointerDown?.(toEvent(e));
    };
    const onMove = (e: MapMouseEvent | MapTouchEvent) => {
      const ev = toEvent(e);
      this.lastSnap = ev.snap;
      this.tool.onPointerMove?.(ev);
      if (!this.pointerDown) this.updateHover(ev.point);
      this.redraw();
      this.events.emit('pointer-move', { lngLat: ev.coord, snap: ev.snap });
    };
    const onUp = (e: MapMouseEvent | MapTouchEvent) => {
      if (!this.pointerDown) return;
      this.pointerDown = false;
      this.tool.onPointerUp?.(toEvent(e));
    };

    map.on('mousedown', onDown);
    map.on('mousemove', onMove);
    map.on('mouseup', onUp);
    map.on('touchstart', (e) => {
      this.lastTouchAt = Date.now();
      if (e.points.length === 1) onDown(e);
    });
    map.on('touchmove', (e) => {
      if (e.points.length === 1) onMove(e);
    });
    map.on('touchend', onUp);
    map.on('click', (e) => this.tool.onClick?.(toEvent(e)));
    map.on('dblclick', (e) => this.tool.onDoubleClick?.(toEvent(e)));
    map.on('mouseout', () => {
      this.lastSnap = null;
      this.updateHover(null);
      this.redraw();
      this.events.emit('pointer-move', { lngLat: null, snap: null });
    });
    // Arrastres que terminan fuera del canvas
    const winUp = () => {
      if (this.pointerDown) {
        this.pointerDown = false;
        this.tool.onPointerUp?.({ point: { x: 0, y: 0 }, lngLat: [0, 0], coord: [0, 0], snap: null, shiftKey: false, altKey: false, ctrlKey: false, preventDefault: () => {} });
      }
    };
    window.addEventListener('mouseup', winUp);
    this.disposers.push(() => window.removeEventListener('mouseup', winUp));

    if (this.options.keyboard !== false) {
      const container = map.getContainer();
      const onKey = (e: KeyboardEvent) => this.handleKey(e);
      container.addEventListener('keydown', onKey);
      this.disposers.push(() => container.removeEventListener('keydown', onKey));
    }
  }

  /** Atajos de teclado. Público para que una interfaz externa pueda reenviar teclas. */
  handleKey(e: KeyboardEvent): void {
    const t = (e.composedPath?.()[0] ?? e.target) as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(t.tagName ?? ''))) {
      // En botones solo se ignoran las teclas que el propio botón usa
      if (t.tagName !== 'BUTTON' || e.key === 'Enter' || e.key === ' ') return;
    }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      this.redo();
      return;
    }
    if (this.tool.onKeyDown?.(e)) {
      e.preventDefault();
      return;
    }
    if (mod || e.altKey) return;
    const shortcuts: Record<string, ToolId> = { v: 'select', p: 'draw-point', l: 'draw-line', g: 'draw-polygon', m: 'move' };
    const tool = shortcuts[e.key.toLowerCase()];
    if (tool) {
      this.setTool(tool);
      e.preventDefault();
    } else if (e.key.toLowerCase() === 's') {
      this.setSnapping(!this.snapper.config.enabled);
      this.message('info', this.snapper.config.enabled ? 'Snapping activado' : 'Snapping desactivado');
      e.preventDefault();
    }
  }

  private redrawQueued = false;

  private redraw(): void {
    if (this.redrawQueued || this.destroyed) return;
    this.redrawQueued = true;
    requestAnimationFrame(() => {
      this.redrawQueued = false;
      if (this.destroyed || !this.map.getSource(OVERLAY_SOURCE)) return;
      const features: Feature[] = this.tool.overlay();
      const s = this.lastSnap;
      if (s && this.tool.snapRequest()) {
        features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: s.coord }, properties: { kind: 'snap', snapType: s.type, zConflict: !!s.zConflict } });
      }
      this.renderer.setOverlay(features);
      this.updateCursor();
    });
  }

  private updateCursor(): void {
    const c = this.tool.cursor() || (this.hover && this.tool.id === 'select' ? 'pointer' : '');
    this.map.getCanvas().style.cursor = c;
  }

  private updateHover(point: ScreenPoint | null): void {
    const hit = point && (this.tool.id === 'select' || this.tool.id === 'move') ? (this.hitTest(point, 3)[0] ?? null) : null;
    if (hit && this.hover && sameRef(hit, this.hover)) return;
    if (this.hover) this.setFeatureState(this.hover, { hover: false });
    this.hover = hit;
    if (hit) this.setFeatureState(hit, { hover: true });
  }

  private setFeatureState(r: FeatureRef, state: Record<string, boolean>): void {
    if (!this.map.getSource(sourceId(r.layerId))) return;
    try {
      this.map.setFeatureState({ source: sourceId(r.layerId), id: r.featureId }, state);
    } catch {
      /* la entidad aún no está en el tile */
    }
  }

  private selectableLayerIds(): string[] {
    const visible = this.store.getLayers().filter((l) => l.visible);
    if (this.options.selectionScope === 'active') return visible.filter((l) => l.id === this.activeLayer).map((l) => l.id);
    return visible.map((l) => l.id);
  }

  private snapLayerIds(): string[] {
    const layers = this.store.getLayers();
    return (this.snapper.config.visibleOnly ? layers.filter((l) => l.visible) : layers).map((l) => l.id);
  }

  private get touchScale(): number {
    return this.coarse || Date.now() - this.lastTouchAt < 1000 ? 3 : 1;
  }

  private hitTest(point: ScreenPoint, tol = 4): FeatureRef[] {
    tol *= this.touchScale;
    return this.queryRefs([
      [point.x - tol, point.y - tol],
      [point.x + tol, point.y + tol],
    ]);
  }

  private hitTestBox(a: ScreenPoint, b: ScreenPoint): FeatureRef[] {
    return this.queryRefs([
      [Math.min(a.x, b.x), Math.min(a.y, b.y)],
      [Math.max(a.x, b.x), Math.max(a.y, b.y)],
    ]);
  }

  private queryRefs(box: [[number, number], [number, number]]): FeatureRef[] {
    const layers = this.renderer.queryLayerIds(this.selectableLayerIds());
    if (!layers.length) return [];
    const out: FeatureRef[] = [];
    for (const f of this.map.queryRenderedFeatures(box, { layers })) {
      const layerId = f.source.replace(/^me-src-/, '');
      const featureId = String(f.properties?.[FID] ?? f.id);
      if (!out.some((r) => r.layerId === layerId && r.featureId === featureId)) out.push({ layerId, featureId });
    }
    return out;
  }

  /**
   * Asa (vértice o punto medio) de la entidad seleccionada bajo el cursor. Se calcula con las
   * coordenadas, no con lo pintado, para no depender de que el mapa haya repintado las asas.
   */
  private hitHandle(point: ScreenPoint): { kind: 'vertex' | 'midpoint'; path: number[] } | null {
    if (this.selection.length !== 1) return null;
    const ref = this.selection[0]!;
    const geometry = this.store.getFeature(ref.layerId, ref.featureId)?.geometry;
    if (!geometry) return null;
    const tol = this.touchScale > 1 ? 18 : 7;
    const dist = (c: Position) => {
      const p = this.projector.project(c);
      return Math.hypot(p.x - point.x, p.y - point.y);
    };
    let best: { kind: 'vertex' | 'midpoint'; path: number[]; d: number } | null = null;
    for (const v of getVertices(geometry)) {
      const d = dist(v.coord);
      if (d <= tol && (!best || d < best.d)) best = { kind: 'vertex', path: v.path, d };
    }
    if (best) return { kind: best.kind, path: best.path };
    if (geometry.type === 'Point' || geometry.type === 'MultiPoint') return null;
    for (const s of getSegments(geometry)) {
      const d = dist(lerpCoord(s.a, s.b, 0.5, false));
      if (d <= tol && (!best || d < best.d)) best = { kind: 'midpoint', path: s.insertPath, d };
    }
    return best ? { kind: best.kind, path: best.path } : null;
  }

  private isEditable(layerId: string): boolean {
    const l = this.store.getLayer(layerId);
    return !!l && l.editable && l.visible;
  }

  private drawTarget(kind: Exclude<GeometryKind, 'Mixed'>): string | null {
    const active = this.activeLayer ? this.store.getLayer(this.activeLayer) : null;
    if (active && active.editable && active.visible) {
      const empty = this.store.featureCount(active.id) === 0;
      if (active.geometryKind === kind || (empty && active.source.format === 'memory')) {
        if (active.geometryKind !== kind) this.store.updateLayer(active.id, { geometryKind: kind });
        return active.id;
      }
      if (active.geometryKind === 'Mixed' && (active.source.format === 'geojson' || active.source.format === 'gpkg' || active.source.format === 'memory')) {
        return active.id;
      }
    }
    const layer = this.createLayer(NEW_LAYER_NAME[kind], kind, { hasZ: active?.source.hasZ ?? false });
    this.message('info', active ? `La capa activa no admite este tipo de geometría: se ha creado "${layer.name}".` : `Se ha creado la capa "${layer.name}".`);
    return layer.id;
  }

  private withZ(c: Position, layerId: string): Position {
    const l = this.store.getLayer(layerId);
    if (!l?.source.hasZ || c.length > 2) return c;
    return [c[0]!, c[1]!, l.defaultZ];
  }

  private preview(layerId: string, featureId: string, geometry: Geometry | null): void {
    const f = this.store.getFeature(layerId, featureId);
    if (!f) return;
    const src = this.map.getSource(sourceId(layerId)) as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    this.previewed.add(layerId);
    void src.updateData({ add: [toRenderFeature({ ...f, geometry })] }).catch(() => undefined);
  }

  private refreshPreview(layerId: string): void {
    if (!this.previewed.has(layerId)) return;
    this.previewed.delete(layerId);
    this.renderer.reload(layerId);
  }

  private layerBounds(id: string): [number, number, number, number] | null {
    let b: [number, number, number, number] | null = null;
    for (const f of this.store.getFeatures(id)) {
      const e = bbox(f.geometry);
      if (!e) continue;
      b = b ? [Math.min(b[0], e[0]), Math.min(b[1], e[1]), Math.max(b[2], e[2]), Math.max(b[3], e[3])] : e;
    }
    return b;
  }

  private fitBounds(b: [number, number, number, number]): void {
    if (b[0] === b[2] && b[1] === b[3]) this.map.easeTo({ center: [b[0], b[1]], zoom: Math.max(this.map.getZoom(), 16) });
    else this.map.fitBounds(b, { padding: 60, maxZoom: 18, duration: 600 });
  }

  private async initAutosave(): Promise<void> {
    const opts = this.options.autosave;
    if (opts === false) return;
    const storage = opts?.storage ?? (typeof indexedDB !== 'undefined' ? new IndexedDbSessionStorage() : null);
    if (!storage) return;
    const key = opts?.key ?? 'default';
    const historyEntries = opts?.historyEntries ?? 50;
    this.autosaver = new Autosaver(
      storage,
      key,
      opts?.debounceMs ?? 1500,
      () => ({
        version: 1,
        savedAt: Date.now(),
        activeLayerId: this.activeLayer,
        layers: this.store.getLayers().map((info) => ({ info, features: this.store.getFeatures(info.id, { includeDeleted: true }).map((f) => structuredClone(f)) })),
        ...(historyEntries > 0 ? { history: this.store.exportHistory(historyEntries) } : {}),
      }),
      (savedAt) => this.events.emit('autosaved', { savedAt }),
      (err) => this.message('error', `No se pudo guardar la sesión: ${err instanceof Error ? err.message : err}`),
    );
    // Guardar inmediatamente al cerrar o al ocultar la pestaña
    const flush = () => void this.autosaver?.flush();
    const onVisibility = () => document.visibilityState === 'hidden' && flush();
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibility);
    this.disposers.push(() => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
    });
    const saved = await this.autosaver.load();
    if (saved && saved.layers.length) {
      this.recoverable = saved;
      this.autosaver.paused = true;
      this.events.emit('session-recoverable', summarize(saved));
    }
  }
}

export const isBasemapLayer = (id: string) => id.startsWith(BASEMAP_PREFIX);
