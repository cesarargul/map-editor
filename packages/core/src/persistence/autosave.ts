import { createStore, del, get, set, type UseStore } from 'idb-keyval';
import type { HistoryEntry } from '../store/store.js';
import type { EditorFeature, LayerInfo } from '../types.js';

export interface SavedSession {
  version: 1;
  savedAt: number;
  activeLayerId: string | null;
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
  clear(key: string): Promise<void>;
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
  }
}

export class MemorySessionStorage implements SessionStorage {
  private data = new Map<string, SavedSession>();
  async load(key: string) {
    return this.data.get(key) ?? null;
  }
  async save(key: string, session: SavedSession) {
    this.data.set(key, structuredClone(session));
  }
  async clear(key: string) {
    this.data.delete(key);
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
  ) {}

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
  }
}
