import { createStore, del, get, set, type UseStore } from 'idb-keyval';
import type { HistoryEntry } from '../store/store.js';
import type { EditorFeature, LayerInfo } from '../types.js';

/** Vista del mapa: ubicación, zoom y orientación. */
export interface SavedView {
  center: [number, number];
  zoom: number;
  bearing: number;
  pitch: number;
}

export function isValidView(v: unknown): v is SavedView {
  const o = v as Partial<SavedView> | null | undefined;
  return (
    !!o &&
    Array.isArray(o.center) &&
    o.center.length === 2 &&
    Number.isFinite(o.center[0]) &&
    Number.isFinite(o.center[1]) &&
    Math.abs(o.center[1]!) <= 90 &&
    Number.isFinite(o.zoom) &&
    Number.isFinite(o.bearing) &&
    Number.isFinite(o.pitch)
  );
}

export interface SavedSession {
  version: 1;
  savedAt: number;
  activeLayerId: string | null;
  /** Vista al guardar. La vista más reciente se guarda aparte (`saveView`) para no reescribir las capas al mover el mapa. */
  view?: SavedView;
  layers: Array<{ info: LayerInfo; features: EditorFeature[] }>;
  history?: { undo: HistoryEntry[]; redo: HistoryEntry[] };
}

export interface SessionSummary {
  savedAt: number;
  layerCount: number;
  featureCount: number;
  changeCount: number;
  layerNames: string[];
}

/** Almacenamiento de sesiones. Por defecto IndexedDB; se puede sustituir (servidor, memoria…). */
export interface SessionStorage {
  load(key: string): Promise<SavedSession | null>;
  save(key: string, session: SavedSession): Promise<void>;
  /** Borra la sesión y su vista. */
  clear(key: string): Promise<void>;
  /** Opcionales: escritura ligera de la vista del mapa, independiente de la sesión completa. */
  loadView?(key: string): Promise<SavedView | null>;
  saveView?(key: string, view: SavedView): Promise<void>;
}

export class IndexedDbSessionStorage implements SessionStorage {
  private store: UseStore | null = null;

  private db(): UseStore {
    this.store ??= createStore('map-editor', 'sessions');
    return this.store;
  }

  async load(key: string): Promise<SavedSession | null> {
    try {
      return ((await get(key, this.db())) as SavedSession | undefined) ?? null;
    } catch {
      return null;
    }
  }

  async save(key: string, session: SavedSession): Promise<void> {
    await set(key, session, this.db());
  }

  async clear(key: string): Promise<void> {
    await del(key, this.db());
    await del(`${key}::view`, this.db());
  }

  async loadView(key: string): Promise<SavedView | null> {
    try {
      return ((await get(`${key}::view`, this.db())) as SavedView | undefined) ?? null;
    } catch {
      return null;
    }
  }

  async saveView(key: string, view: SavedView): Promise<void> {
    await set(`${key}::view`, view, this.db());
  }
}

export class MemorySessionStorage implements SessionStorage {
  private data = new Map<string, SavedSession>();
  private views = new Map<string, SavedView>();
  async loadView(key: string) {
    return this.views.get(key) ?? null;
  }
  async saveView(key: string, view: SavedView) {
    this.views.set(key, structuredClone(view));
  }
  async load(key: string) {
    return this.data.get(key) ?? null;
  }
  async save(key: string, session: SavedSession) {
    this.data.set(key, structuredClone(session));
  }
  async clear(key: string) {
    this.data.delete(key);
    this.views.delete(key);
  }
}

export function summarize(session: SavedSession): SessionSummary {
  let featureCount = 0;
  let changeCount = 0;
  for (const l of session.layers) {
    for (const f of l.features) {
      if (f.status !== 'deleted') featureCount++;
      if (f.status !== 'original') changeCount++;
    }
  }
  return {
    savedAt: session.savedAt,
    layerCount: session.layers.length,
    featureCount,
    changeCount,
    layerNames: session.layers.map((l) => l.info.name),
  };
}

export interface AutosaveOptions {
  /** Clave de la sesión (una por instancia/aplicación). */
  key?: string;
  debounceMs?: number;
  storage?: SessionStorage;
  /** Guardar también el historial de deshacer (últimas N entradas). 0 = no guardar. */
  historyEntries?: number;
}

/** Programa guardados con retardo y evita solapes. */
export class Autosaver {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private viewTimer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> | null = null;
  private pending = false;
  paused = false;

  constructor(
    private readonly storage: SessionStorage,
    private readonly key: string,
    private readonly debounceMs: number,
    private readonly snapshot: () => SavedSession,
    private readonly onSaved: (savedAt: number) => void,
    private readonly onError: (err: unknown) => void,
    /** Vista actual del mapa, o `null` si no hay nada que recordar (p. ej. no hay capas). */
    private readonly snapshotView?: () => SavedView | null,
  ) {}

  /** Programa guardar solo la vista (barato: no reescribe las capas). */
  scheduleView(): void {
    if (this.paused || !this.snapshotView || !this.storage.saveView) return;
    if (this.viewTimer) clearTimeout(this.viewTimer);
    this.viewTimer = setTimeout(() => void this.flushView(), 800);
  }

  async flushView(): Promise<void> {
    if (this.viewTimer) {
      clearTimeout(this.viewTimer);
      this.viewTimer = null;
    }
    if (this.paused || !this.snapshotView || !this.storage.saveView) return;
    const view = this.snapshotView();
    if (!view) return;
    try {
      await this.storage.saveView(this.key, view);
    } catch (err) {
      this.onError(err);
    }
  }

  /** La vista guardada más reciente (la del guardado ligero si existe; si no, la de la sesión). */
  async loadView(session?: SavedSession | null): Promise<SavedView | null> {
    const light = (await this.storage.loadView?.(this.key)) ?? null;
    if (isValidView(light)) return light;
    return isValidView(session?.view) ? session!.view! : null;
  }

  /** Guarda de inmediato la sesión y la vista. */
  async flushAll(): Promise<void> {
    await Promise.all([this.flush(), this.flushView()]);
  }

  schedule(): void {
    if (this.paused) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.debounceMs);
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.paused) return;
    if (this.saving) {
      this.pending = true;
      return this.saving;
    }
    const session = this.snapshot();
    this.saving = this.storage
      .save(this.key, session)
      .then(() => this.onSaved(session.savedAt))
      .catch(this.onError)
      .finally(() => {
        this.saving = null;
        if (this.pending) {
          this.pending = false;
          void this.flush();
        }
      });
    return this.saving;
  }

  load(): Promise<SavedSession | null> {
    return this.storage.load(this.key);
  }

  clear(): Promise<void> {
    return this.storage.clear(this.key);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.viewTimer) clearTimeout(this.viewTimer);
  }
}
