import { css, html, LitElement, nothing, unsafeCSS, type PropertyValues } from 'lit';
import maplibreCss from 'maplibre-gl/dist/maplibre-gl.css?inline';
import {
  installDropZone,
  MapEditor,
  type BasemapDef,
  type MapEditorOptions,
  type MessageLevel,
  type SessionSummary,
  type SnapConfig,
} from '@map-editor/core';
import { icons } from './icons.js';
import { controls, theme } from './styles.js';

interface Toast {
  id: number;
  level: MessageLevel;
  text: string;
}

const ALL_UI = ['toolbar', 'layers', 'attributes', 'table', 'basemaps', 'status'] as const;
type UiPart = (typeof ALL_UI)[number];

/**
 * `<map-editor>`: editor vectorial completo listo para usar en cualquier aplicación.
 *
 * Atributos: `basemap`, `center` ("lon,lat"), `zoom`, `storage-key`, `no-autosave`,
 * `osm-tile-url`, `sql-wasm-url`, `gdal-path`, `worker-url` (worker de MapLibre), `ui` (partes visibles),
 * `theme` (light|dark).
 * Propiedades: `snapping` (SnapConfig parcial), `basemaps` (BasemapDef[]), `editor` (solo lectura).
 * Eventos: `editor-ready`, `editor-change`, `selection-change`, `layers-change`, `editor-message`.
 */
export class MapEditorElement extends LitElement {
  static override properties = {
    basemap: { type: String },
    center: { type: String },
    zoom: { type: Number },
    storageKey: { type: String, attribute: 'storage-key' },
    noAutosave: { type: Boolean, attribute: 'no-autosave' },
    osmTileUrl: { type: String, attribute: 'osm-tile-url' },
    sqlWasmUrl: { type: String, attribute: 'sql-wasm-url' },
    gdalPath: { type: String, attribute: 'gdal-path' },
    workerUrl: { type: String, attribute: 'worker-url' },
    ui: { type: String },
    snapping: { attribute: false },
    basemaps: { attribute: false },
    toasts: { state: true },
    dragging: { state: true },
    dialog: { state: true },
    tableOpen: { state: true },
    panelOpen: { state: true },
    recoverable: { state: true },
    loading: { state: true },
  };

  declare basemap: string;
  declare center: string;
  declare zoom: number;
  declare storageKey: string;
  declare noAutosave: boolean;
  declare osmTileUrl: string;
  declare sqlWasmUrl: string;
  declare gdalPath: string;
  declare workerUrl: string;
  declare ui: string;
  declare snapping: Partial<SnapConfig> | undefined;
  declare basemaps: BasemapDef[] | undefined;
  declare toasts: Toast[];
  declare dragging: boolean;
  declare dialog: { kind: 'export'; layerId: string } | { kind: 'snap' } | null;
  declare tableOpen: boolean;
  declare panelOpen: boolean;
  declare recoverable: SessionSummary | null;
  declare loading: boolean;

  private static lastActive: MapEditorElement | null = null;
  private _editor: MapEditor | null = null;
  private toastId = 0;
  private cleanup: Array<() => void> = [];

  /** Instancia del editor headless (disponible tras `editor-ready`). */
  get editor(): MapEditor | null {
    return this._editor;
  }

  /** Promesa que se resuelve con el editor cuando está listo. */
  readonly whenReady: Promise<MapEditor>;
  private resolveReady!: (e: MapEditor) => void;

  static override styles = [
    unsafeCSS(maplibreCss),
    theme,
    controls,
    css`
      :host {
        display: block;
        position: relative;
        outline: none;
        width: 100%;
        height: 100%;
        min-height: 320px;
        overflow: hidden;
      }
      .layout {
        position: absolute;
        inset: 0;
        display: grid;
        grid-template-rows: 1fr auto;
      }
      .stage {
        position: relative;
        min-height: 0;
      }
      #map {
        position: absolute;
        inset: 0;
      }
      .toolbar {
        position: absolute;
        top: 10px;
        left: 10px;
        z-index: 3;
      }
      .side {
        position: absolute;
        top: 10px;
        right: 54px;
        width: min(340px, calc(100% - 120px));
        max-height: calc(100% - 70px);
        display: flex;
        flex-direction: column;
        gap: 8px;
        z-index: 3;
        overflow: auto;
      }
      .side.closed {
        width: auto;
      }
      .side-toggle {
        align-self: flex-end;
      }
      .bottom-left {
        position: absolute;
        left: 10px;
        right: 190px;
        bottom: 10px;
        z-index: 3;
        display: flex;
        gap: 8px;
        align-items: flex-end;
        pointer-events: none;
      }
      .bottom-left > * {
        pointer-events: auto;
        flex: none;
      }
      .bottom-left me-status-bar {
        flex: 0 1 auto;
        min-width: 0;
      }
      .table {
        height: min(38vh, 320px);
        border-top: 1px solid var(--me-border);
        background: var(--me-bg);
        display: flex;
        flex-direction: column;
        min-height: 0;
      }
      me-attribute-table {
        flex: 1;
        min-height: 0;
      }
      .drop {
        position: absolute;
        inset: 0;
        z-index: 30;
        display: grid;
        place-items: center;
        background: color-mix(in srgb, var(--me-primary) 20%, transparent);
        border: 3px dashed var(--me-primary);
        pointer-events: none;
        font-size: 18px;
        font-weight: 600;
        color: var(--me-fg);
      }
      .drop span {
        background: var(--me-bg);
        padding: 12px 20px;
        border-radius: var(--me-radius);
        box-shadow: var(--me-shadow);
      }
      .toasts {
        position: absolute;
        left: 50%;
        transform: translateX(-50%);
        top: 10px;
        z-index: 25;
        display: flex;
        flex-direction: column;
        gap: 6px;
        width: min(520px, calc(100% - 140px));
      }
      .toast {
        padding: 8px 10px 8px 12px;
        display: flex;
        gap: 8px;
        align-items: flex-start;
        border-left: 4px solid var(--me-primary);
      }
      .toast.warning {
        border-left-color: var(--me-modified);
      }
      .toast.error {
        border-left-color: var(--me-deleted);
      }
      .toast span {
        flex: 1;
        padding-top: 3px;
      }
      .banner {
        position: absolute;
        left: 50%;
        transform: translateX(-50%);
        bottom: 46px;
        z-index: 24;
        padding: 10px 12px;
        display: flex;
        gap: 10px;
        align-items: center;
        flex-wrap: wrap;
        width: min(640px, calc(100% - 20px));
      }
      .banner span {
        flex: 1;
        min-width: 200px;
      }
      .actions {
        position: absolute;
        left: 50%;
        transform: translateX(-50%);
        bottom: 52px;
        z-index: 4;
        width: max-content;
        max-width: calc(100% - 20px);
      }
      .loading {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        z-index: 26;
        padding: 10px 16px;
      }
      .maplibregl-ctrl-bottom-right {
        bottom: 0;
      }
      @media (max-width: 640px) {
        .bottom-left {
          right: 10px;
        }
        .bottom-left me-status-bar {
          display: none;
        }
        .maplibregl-ctrl-bottom-right .maplibregl-ctrl-scale {
          display: none;
        }
        .actions {
          bottom: 64px;
        }
        .side {
          right: 10px;
          top: auto;
          bottom: 56px;
          width: calc(100% - 20px);
          max-height: 45%;
        }
        .toolbar {
          right: 54px;
        }
        .toasts {
          width: auto;
          left: 10px;
          right: 60px;
          transform: none;
          top: 70px;
          bottom: auto;
        }
        .side.closed {
          bottom: auto;
          top: 64px;
          width: auto;
        }
      }
    `,
  ];

  constructor() {
    super();
    this.basemap = 'osm';
    this.center = '';
    this.zoom = NaN;
    this.storageKey = 'default';
    this.noAutosave = false;
    this.osmTileUrl = '';
    this.sqlWasmUrl = '';
    this.gdalPath = '';
    this.workerUrl = '';
    this.ui = ALL_UI.join(' ');
    this.snapping = undefined;
    this.basemaps = undefined;
    this.toasts = [];
    this.dragging = false;
    this.dialog = null;
    this.tableOpen = false;
    // En pantallas pequeñas los paneles empiezan plegados para dejar sitio al mapa
    this.panelOpen = typeof matchMedia === 'undefined' || !matchMedia('(max-width: 640px)').matches;
    this.recoverable = null;
    this.loading = false;
    this.whenReady = new Promise((r) => (this.resolveReady = r));
  }

  override connectedCallback(): void {
    super.connectedCallback();
    // Enfocable al hacer clic en cualquier zona del componente (atajos de teclado)
    if (!this.hasAttribute('tabindex')) this.tabIndex = -1;
  }

  private has(part: UiPart): boolean {
    return this.ui.split(/[\s,]+/).includes(part);
  }

  protected override firstUpdated(): void {
    const container = this.renderRoot.querySelector<HTMLElement>('#map')!;
    const center = this.center
      .split(',')
      .map(Number)
      .filter((n) => Number.isFinite(n));
    const opts: MapEditorOptions = {
      container,
      basemap: this.basemap,
      ...(this.basemaps ? { basemaps: this.basemaps } : {}),
      ...(this.osmTileUrl ? { osmTileUrl: this.osmTileUrl } : {}),
      ...(center.length === 2 ? { center: center as [number, number] } : {}),
      ...(Number.isFinite(this.zoom) ? { zoom: this.zoom } : {}),
      ...(this.snapping ? { snapping: this.snapping } : {}),
      ...(this.workerUrl ? { workerUrl: this.workerUrl } : {}),
      autosave: this.noAutosave ? false : { key: this.storageKey },
      // El teclado se gestiona en el propio componente para que funcione con el foco en cualquier panel
      keyboard: false,
      io: {
        ...(this.sqlWasmUrl ? { sqlWasmUrl: this.sqlWasmUrl } : {}),
        ...(this.gdalPath ? { gdal: { path: this.gdalPath } } : {}),
      },
    };
    const ed = new MapEditor(opts);
    this._editor = ed;
    this.cleanup.push(
      ed.on('message', (m) => this.toast(m.level, m.text)),
      ed.on('session-recoverable', (s) => (this.recoverable = s)),
      ed.on('features-changed', (e) => this.emit('editor-change', e)),
      ed.on('selection-changed', (e) => this.emit('selection-change', e)),
      ed.on('layers-changed', (e) => this.emit('layers-change', e)),
      ed.on('message', (e) => this.emit('editor-message', e)),
      (() => {
        const onKey = (e: KeyboardEvent) => {
          if (this.dialog) return;
          ed.handleKey(e);
        };
        // Si el foco vuelve a <body> (p. ej. el botón pulsado desaparece), los atajos los recibe
        // el último editor con el que se interactuó.
        const onDocKey = (e: KeyboardEvent) => {
          if (MapEditorElement.lastActive === this && (e.target === document.body || e.target === document.documentElement)) onKey(e);
        };
        const onPointer = () => (MapEditorElement.lastActive = this);
        this.addEventListener('keydown', onKey);
        this.addEventListener('pointerdown', onPointer, true);
        document.addEventListener('keydown', onDocKey);
        return () => {
          this.removeEventListener('keydown', onKey);
          this.removeEventListener('pointerdown', onPointer, true);
          document.removeEventListener('keydown', onDocKey);
          if (MapEditorElement.lastActive === this) MapEditorElement.lastActive = null;
        };
      })(),
      installDropZone(this, {
        onFiles: (files) => void this.loadFiles(files),
        onDragStateChange: (a) => (this.dragging = a),
      }),
    );
    void ed.ready.then(() => {
      this.requestUpdate();
      this.resolveReady(ed);
      this.emit('editor-ready', { editor: ed });
    });
    // Ajustar el mapa cuando cambie el tamaño del contenedor
    const ro = new ResizeObserver(() => ed.map.resize());
    ro.observe(container);
    this.cleanup.push(() => ro.disconnect());
  }

  protected override updated(changed: PropertyValues<this>): void {
    const ed = this._editor;
    if (!ed) return;
    if (changed.has('basemap') && changed.get('basemap') !== undefined) ed.setBasemap(this.basemap);
    if (changed.has('snapping') && this.snapping && changed.get('snapping') !== undefined) ed.setSnapConfig(this.snapping);
    if (changed.has('tableOpen')) requestAnimationFrame(() => ed.map.resize());
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.cleanup.forEach((c) => c());
    this.cleanup = [];
    this._editor?.destroy();
    this._editor = null;
  }

  /** Carga ficheros mostrando un indicador de progreso. */
  async loadFiles(files: File[]): Promise<void> {
    if (!this._editor) return;
    this.loading = true;
    try {
      await this._editor.loadFiles(files);
    } catch (err) {
      this.toast('error', err instanceof Error ? err.message : String(err));
    } finally {
      this.loading = false;
    }
  }

  override render() {
    const ed = this._editor;
    return html`<div class="layout">
      <div class="stage">
        <div id="map"></div>
        ${ed
          ? html`
              ${this.has('toolbar') ? html`<me-toolbar class="toolbar" .editor=${ed} @me-open-snap-settings=${() => (this.dialog = { kind: 'snap' })}></me-toolbar>` : nothing}
              ${this.has('layers') || this.has('attributes')
                ? html`<div class="side ${this.panelOpen ? '' : 'closed'}">
                    <button class="panel side-toggle icon" title=${this.panelOpen ? 'Ocultar paneles' : 'Mostrar paneles'} aria-label="Paneles" aria-expanded=${this.panelOpen} @click=${() => (this.panelOpen = !this.panelOpen)}>
                      ${this.panelOpen ? icons.close : icons.layers}
                    </button>
                    ${this.panelOpen
                      ? html`${this.has('layers') ? html`<me-layer-panel class="panel" .editor=${ed} @me-open-export=${(e: CustomEvent<{ layerId: string }>) => (this.dialog = { kind: 'export', layerId: e.detail.layerId })}></me-layer-panel>` : nothing}
                        ${this.has('attributes') ? html`<me-attribute-panel class="panel" .editor=${ed}></me-attribute-panel>` : nothing}`
                      : nothing}
                  </div>`
                : nothing}
              <div class="bottom-left">
                ${this.has('basemaps') ? html`<me-basemap-switcher .editor=${ed}></me-basemap-switcher>` : nothing}
                ${this.has('table') && !this.tableOpen
                  ? html`<button class="panel" title="Tabla de atributos" @click=${() => (this.tableOpen = true)}>${icons.table} Tabla</button>`
                  : nothing}
                ${this.has('status') ? html`<me-status-bar .editor=${ed}></me-status-bar>` : nothing}
              </div>

            `
          : nothing}
        ${ed && this.has('toolbar') ? html`<me-edit-actions class="actions" .editor=${ed}></me-edit-actions>` : nothing}
        ${this.renderRecovery()} ${this.renderToasts()}
        ${this.loading ? html`<div class="loading panel">Leyendo ficheros…</div>` : nothing}
        ${this.dragging ? html`<div class="drop"><span>Suelta aquí los ficheros (GeoJSON, Shapefile, KML, GPX, GeoPackage, FlatGeobuf…)</span></div>` : nothing}
        ${ed && this.dialog?.kind === 'export'
          ? html`<me-export-dialog .editor=${ed} .layerId=${this.dialog.layerId} @me-close-dialog=${() => (this.dialog = null)}></me-export-dialog>`
          : nothing}
        ${ed && this.dialog?.kind === 'snap' ? html`<me-snap-settings .editor=${ed} @me-close-dialog=${() => (this.dialog = null)}></me-snap-settings>` : nothing}
      </div>
      ${ed && this.tableOpen ? html`<div class="table"><me-attribute-table .editor=${ed} @me-close-table=${() => (this.tableOpen = false)}></me-attribute-table></div>` : nothing}
    </div>`;
  }

  private renderRecovery() {
    const r = this.recoverable;
    if (!r) return nothing;
    const when = new Date(r.savedAt).toLocaleString();
    return html`<div class="banner panel" role="alert">
      ${icons.info}
      <span>Hay una sesión guardada en este navegador (${when}): ${r.layerCount} capa${r.layerCount === 1 ? '' : 's'}, ${r.changeCount} cambio${r.changeCount === 1 ? '' : 's'}.</span>
      <button class="primary" @click=${async () => ((this.recoverable = null), await this._editor?.restoreSession())}>Recuperar</button>
      <button
        class="outline"
        @click=${async () => {
          if (r.changeCount && !confirm('Se perderán los cambios de la sesión guardada. ¿Descartarla?')) return;
          this.recoverable = null;
          await this._editor?.discardSession();
        }}
      >
        Descartar
      </button>
    </div>`;
  }

  private renderToasts() {
    if (!this.toasts.length) return nothing;
    return html`<div class="toasts" aria-live="polite">
      ${this.toasts.map(
        (t) => html`<div class="toast panel ${t.level}" role=${t.level === 'error' ? 'alert' : 'status'}>
          <span>${t.text}</span>
          <button class="icon" aria-label="Cerrar aviso" @click=${() => this.dismiss(t.id)}>${icons.close}</button>
        </div>`,
      )}
    </div>`;
  }

  private toast(level: MessageLevel, text: string): void {
    const id = ++this.toastId;
    this.toasts = [...this.toasts.slice(-3), { id, level, text }];
    setTimeout(() => this.dismiss(id), level === 'error' ? 12000 : level === 'warning' ? 8000 : 4000);
  }

  private dismiss(id: number): void {
    this.toasts = this.toasts.filter((t) => t.id !== id);
  }

  private emit(name: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }
}
