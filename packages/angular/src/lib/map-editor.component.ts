import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  type OnDestroy,
  type OnInit,
} from '@angular/core';
import '@map-editor/web-component';
import type { EditorEvents, FeatureRef, LayerInfo, MapEditor, MapEditorElement, SnapConfig } from '@map-editor/web-component';
import { MAP_EDITOR_CONFIG } from './config';

/**
 * Componente Angular para el editor vectorial. Crea el Web Component `<map-editor>` ya configurado
 * (el worker de MapLibre y el autoguardado deben conocerse antes de crear el mapa) y expone su
 * estado como signals.
 *
 * ```html
 * <me-map-editor storageKey="obras" (ready)="onReady($event)" (selectionChange)="sel.set($event)" />
 * ```
 */
@Component({
  selector: 'me-map-editor',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '',
  styles: [
    `
      :host {
        display: block;
        position: relative;
        min-height: 320px;
      }
      :host > map-editor {
        position: absolute;
        inset: 0;
      }
    `,
  ],
})
export class MapEditorComponent implements OnInit, OnDestroy {
  private readonly config = inject(MAP_EDITOR_CONFIG);
  private readonly hostRef = inject<ElementRef<HTMLElement>>(ElementRef);
  private el: MapEditorElement | null = null;
  private listeners: Array<() => void> = [];

  // --- Entradas -------------------------------------------------------------------------------
  /** Mapa base (reactivo). */
  readonly basemap = input<string>();
  readonly center = input<[number, number]>();
  readonly zoom = input<number>();
  /** Clave del autoguardado (una por pantalla/proyecto). Solo se lee al iniciar. */
  readonly storageKey = input<string>('default');
  readonly autosave = input<boolean>(true);
  /** Partes de la interfaz: toolbar layers attributes table basemaps status (reactivo). */
  readonly ui = input<string>('toolbar layers attributes table basemaps status');
  /** Configuración de snapping (reactiva). */
  readonly snapping = input<Partial<SnapConfig>>();
  readonly theme = input<'light' | 'dark'>();
  readonly workerUrl = input<string>();
  readonly sqlWasmUrl = input<string>();
  readonly gdalPath = input<string>();
  readonly osmTileUrl = input<string>();

  // --- Salidas --------------------------------------------------------------------------------
  readonly ready = output<MapEditor>();
  readonly featuresChange = output<EditorEvents['features-changed']>();
  readonly selectionChange = output<FeatureRef[]>();
  readonly layersChange = output<LayerInfo[]>();
  readonly message = output<EditorEvents['message']>();

  // --- Estado como signals --------------------------------------------------------------------
  /** Instancia del editor headless (null hasta que esté listo). */
  readonly editor = signal<MapEditor | null>(null);
  readonly selection = signal<FeatureRef[]>([]);
  readonly layers = signal<LayerInfo[]>([]);

  constructor() {
    // Entradas que pueden cambiar en caliente
    effect(() => {
      const basemap = this.basemap() ?? this.config.basemap;
      if (this.el && basemap) untracked(() => (this.el!.basemap = basemap));
    });
    effect(() => {
      const ui = this.ui();
      if (this.el) untracked(() => (this.el!.ui = ui));
    });
    effect(() => {
      const snapping = this.snapping();
      if (this.el && snapping) untracked(() => (this.el!.snapping = snapping));
    });
    effect(() => {
      const theme = this.theme();
      if (!this.el) return;
      if (theme) this.el.setAttribute('theme', theme);
      else this.el.removeAttribute('theme');
    });
  }

  ngOnInit(): void {
    const el = document.createElement('map-editor');
    const c = this.config;
    el.basemap = this.basemap() ?? c.basemap ?? 'osm';
    el.center = this.center()?.join(',') ?? '';
    el.zoom = this.zoom() ?? Number.NaN;
    el.storageKey = this.storageKey();
    el.noAutosave = !this.autosave();
    el.ui = this.ui();
    el.osmTileUrl = this.osmTileUrl() ?? c.osmTileUrl ?? '';
    el.sqlWasmUrl = this.sqlWasmUrl() ?? c.sqlWasmUrl ?? '';
    el.gdalPath = this.gdalPath() ?? c.gdalPath ?? '';
    el.workerUrl = this.workerUrl() ?? c.workerUrl ?? '';
    const snapping = this.snapping() ?? c.snapping;
    if (snapping) el.snapping = snapping;
    if (c.basemaps) el.basemaps = c.basemaps;
    const theme = this.theme();
    if (theme) el.setAttribute('theme', theme);

    const on = <T>(name: string, fn: (detail: T) => void) => {
      const h = (e: Event) => fn((e as CustomEvent<T>).detail);
      el.addEventListener(name, h);
      this.listeners.push(() => el.removeEventListener(name, h));
    };
    on<{ editor: MapEditor }>('editor-ready', ({ editor }) => {
      this.editor.set(editor);
      this.layers.set(editor.getLayers());
      this.ready.emit(editor);
    });
    on<EditorEvents['features-changed']>('editor-change', (d) => this.featuresChange.emit(d));
    on<{ selection: FeatureRef[] }>('selection-change', ({ selection }) => {
      this.selection.set(selection);
      this.selectionChange.emit(selection);
    });
    on<{ layers: LayerInfo[] }>('layers-change', ({ layers }) => {
      this.layers.set(layers);
      this.layersChange.emit(layers);
    });
    on<EditorEvents['message']>('editor-message', (d) => this.message.emit(d));

    this.el = el;
    this.hostRef.nativeElement.appendChild(el);
  }

  /** El elemento `<map-editor>` subyacente. */
  get element(): MapEditorElement | null {
    return this.el;
  }

  /** Carga ficheros en el editor (equivale a soltarlos sobre el mapa). */
  async loadFiles(files: File[]): Promise<void> {
    await this.el?.loadFiles(files);
  }

  ngOnDestroy(): void {
    this.listeners.forEach((l) => l());
    this.listeners = [];
    this.el?.remove();
    this.el = null;
    this.editor.set(null);
  }
}
