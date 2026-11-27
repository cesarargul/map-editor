import { Autosaver, isValidView, MemorySessionStorage, type SavedSession, type SavedView } from '../src/persistence/autosave.js';

const view: SavedView = { center: [-3.7, 40.4], zoom: 13.37, bearing: 20, pitch: 0 };
const session = (v?: SavedView): SavedSession => ({ version: 1, savedAt: 1, activeLayerId: null, layers: [], ...(v ? { view: v } : {}) });

describe('isValidView', () => {
  it('acepta una vista correcta y rechaza datos corruptos', () => {
    expect(isValidView(view)).toBe(true);
    expect(isValidView(null)).toBe(false);
    expect(isValidView({ ...view, zoom: NaN })).toBe(false);
    expect(isValidView({ ...view, center: [0, 123] })).toBe(false);
    expect(isValidView({ ...view, center: [0] })).toBe(false);
  });
});

describe('vista guardada aparte', () => {
  const make = (storage: MemorySessionStorage, current: SavedView | null) =>
    new Autosaver(storage, 'k', 10, () => session(), () => {}, (e) => { throw e; }, () => current);

  it('la vista ligera se guarda y tiene prioridad sobre la de la sesión', async () => {
    const storage = new MemorySessionStorage();
    await storage.save('k', session({ ...view, zoom: 5 }));
    const a = make(storage, view);
    await a.flushView();
    expect(await a.loadView(await a.load())).toEqual(view);
  });

  it('sin guardado ligero usa la vista de la sesión; sin ninguna, null', async () => {
    const storage = new MemorySessionStorage();
    const a = make(storage, null);
    await storage.save('k', session(view));
    expect(await a.loadView(await a.load())).toEqual(view);
    await storage.save('k', session());
    expect(await a.loadView(await a.load())).toBeNull();
  });

  it('no guarda si no hay nada que recordar o está en pausa, y clear() la borra', async () => {
    const storage = new MemorySessionStorage();
    const a = make(storage, null);
    await a.flushView();
    expect(await storage.loadView('k')).toBeNull();
    const b = make(storage, view);
    b.paused = true;
    await b.flushView();
    expect(await storage.loadView('k')).toBeNull();
    b.paused = false;
    await b.flushView();
    expect(await storage.loadView('k')).toEqual(view);
    await b.clear();
    expect(await storage.loadView('k')).toBeNull();
  });
});
