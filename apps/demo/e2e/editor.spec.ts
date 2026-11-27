import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

type LngLat = [number, number];

async function ready(page: Page) {
  await page.goto('/');
  await page.waitForSelector('body[data-ready=true]');
}

/** Simula soltar ficheros sobre el componente. */
async function dropFiles(page: Page, files: Array<{ name: string; path: string }>) {
  const payload = files.map((f) => ({ name: f.name, b64: readFileSync(f.path).toString('base64') }));
  await page.evaluate(async (items) => {
    const dt = new DataTransfer();
    for (const it of items) {
      const bin = Uint8Array.from(atob(it.b64), (c) => c.charCodeAt(0));
      dt.items.add(new File([bin], it.name));
    }
    const target = document.querySelector('map-editor')!;
    target.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
    target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
  }, payload);
}

const sample = (name: string) => ({ name, path: new URL(`../public/samples/${name}`, import.meta.url).pathname });

async function loadSample(page: Page, name: string) {
  const before = await page.evaluate(() => window.editor.getLayers().length);
  await page.click(`[data-sample="${name}"]`);
  await page.waitForFunction((n) => window.editor.getLayers().length > n, before);
  await page.evaluate(() => new Promise((r) => window.editor.map.once('idle', r)));
}

/** Coordenadas de página de un punto geográfico (UTM 30N → WGS84 ya resuelto en el test). */
async function toScreen(page: Page, lngLat: LngLat) {
  return page.evaluate((c) => {
    const rect = document.querySelector('map-editor')!.shadowRoot!.querySelector('#map')!.getBoundingClientRect();
    const p = window.editor.map.project(c);
    return { x: rect.left + p.x, y: rect.top + p.y };
  }, lngLat);
}

async function utm(page: Page, x: number, y: number): Promise<LngLat> {
  return page.evaluate(([a, b]) => {
    const g = window.mapEditorCore.transformGeometry({ type: 'Point', coordinates: [a!, b!] }, 'EPSG:25830', 'EPSG:4326') as unknown as { coordinates: LngLat };
    return g.coordinates;
  }, [x, y]);
}

/** Centra el mapa en un punto UTM (zona libre de paneles) y espera a que se pinte. */
async function focusOn(page: Page, x: number, y: number, zoom = 17) {
  const c = await utm(page, x, y);
  await page.evaluate(([center, z]) => {
    window.editor.map.jumpTo({ center: center as LngLat, zoom: z as number });
    return new Promise((r) => window.editor.map.once('idle', r));
  }, [c, zoom] as const);
}

async function featureCount(page: Page, layerName: string) {
  return page.evaluate((n) => {
    const l = window.editor.getLayers().find((x) => x.name === n)!;
    return window.editor.store.featureCount(l.id);
  }, layerName);
}

test.beforeEach(async ({ page }) => {
  await ready(page);
});

test('carga ficheros arrastrándolos (GeoJSON 3D y Shapefile en ZIP)', async ({ page }) => {
  await dropFiles(page, [sample('red_abastecimiento.geojson'), sample('parcelas.zip')]);
  await expect(page.locator('me-layer-panel li')).toHaveCount(2);
  await expect(page.locator('me-layer-panel')).toContainText('red_abastecimiento');
  await expect(page.locator('me-layer-panel')).toContainText('EPSG:25830');
  const layers = await page.evaluate(() => window.editor.getLayers().map((l) => ({ name: l.name, z: l.source.hasZ, fmt: l.source.format })));
  expect(layers).toEqual([
    { name: 'parcelas', z: false, fmt: 'shapefile' },
    { name: 'red_abastecimiento', z: true, fmt: 'geojson' },
  ]);
});

test('dibuja una línea enganchando a un vértice y hereda su Z', async ({ page }) => {
  await loadSample(page, 'red_abastecimiento.geojson');
  await focusOn(page, 440200, 4474000);
  const vertex = await utm(page, 440200, 4474000);
  const p0 = await toScreen(page, vertex);
  const p1 = await toScreen(page, await utm(page, 440150, 4473930));
  const p2 = await toScreen(page, await utm(page, 440110, 4473880));

  await page.keyboard.press('Escape');
  await page.locator('me-toolbar button[aria-label="Dibujar línea"]').click();
  await page.mouse.move(p0.x + 5, p0.y - 4);
  await expect(page.locator('me-status-bar')).toContainText('vértice');
  await page.mouse.click(p0.x + 5, p0.y - 4);
  await page.mouse.click(p1.x, p1.y);
  await page.mouse.dblclick(p2.x, p2.y);

  await expect.poll(() => featureCount(page, 'red_abastecimiento')).toBe(4);
  const first = await page.evaluate(() => {
    const sel = window.editor.getSelection()[0]!;
    const f = window.editor.store.getFeature(sel.layerId, sel.featureId)!;
    return (f.geometry as { coordinates: number[][] }).coordinates[0]!;
  });
  expect(first[0]).toBeCloseTo(vertex[0], 9);
  expect(first[1]).toBeCloseTo(vertex[1], 9);
  expect(first[2]).toBe(650);
});

test('detecta el cruce sin conexión 3D entre tubería y calle', async ({ page }) => {
  await loadSample(page, 'red_abastecimiento.geojson');
  await loadSample(page, 'calles.geojson');
  await focusOn(page, 440100, 4474000);
  const cross = await toScreen(page, await utm(page, 440100, 4474000));
  await page.locator('me-toolbar button[aria-label="Dibujar línea"]').click();
  await page.mouse.move(cross.x + 3, cross.y + 2);
  await expect(page.locator('me-status-bar')).toContainText('Cruce sin conexión 3D');
  await expect(page.locator('me-status-bar')).toContainText('650.00 / 651.');
});

test('edita un vértice, deshace y rehace', async ({ page }) => {
  await loadSample(page, 'red_abastecimiento.geojson');
  await focusOn(page, 440300, 4474000);
  const mid = await toScreen(page, await utm(page, 440275, 4474000));
  await page.mouse.click(mid.x, mid.y);
  await expect(page.locator('me-attribute-panel')).toContainText('Atributos');
  await expect(page.locator('me-attribute-panel input[aria-label="codigo"]')).toHaveValue('T-002');

  const end = await toScreen(page, await utm(page, 440350, 4474000));
  const target = await toScreen(page, await utm(page, 440330, 4473940));
  const original = await page.evaluate(() => {
    const s = window.editor.getSelection()[0]!;
    return JSON.stringify(window.editor.store.getFeature(s.layerId, s.featureId)!.geometry);
  });
  // Arrastrar el extremo a una zona libre (sin nada a lo que engancharse)
  await page.mouse.move(end.x, end.y);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 6 });
  await page.mouse.up();

  const changed = await page.evaluate(() => {
    const s = window.editor.getSelection()[0]!;
    return JSON.stringify(window.editor.store.getFeature(s.layerId, s.featureId)!.geometry);
  });
  expect(changed).not.toBe(original);
  await expect(page.locator('me-layer-panel .badge.modified')).toHaveText('~1');

  await page.keyboard.press('Control+z');
  await expect.poll(() => page.evaluate(() => {
    const l = window.editor.getLayers()[0]!;
    return window.editor.store.changeSummary(l.id).modified;
  })).toBe(0);
  await page.keyboard.press('Control+y');
  await expect(page.locator('me-layer-panel .badge.modified')).toHaveText('~1');
});

test('edita atributos y borra con Supr', async ({ page }) => {
  await loadSample(page, 'red_abastecimiento.geojson');
  await focusOn(page, 440100, 4474000);
  const mid = await toScreen(page, await utm(page, 440100, 4474000));
  await page.mouse.click(mid.x, mid.y);
  const input = page.locator('me-attribute-panel input[aria-label="material"]');
  await expect(input).toHaveValue('Fundición dúctil');
  await input.fill('Acero');
  await input.press('Enter');
  await input.blur();
  await expect.poll(() => page.evaluate(() => {
    const s = window.editor.getSelection()[0]!;
    return window.editor.store.getFeature(s.layerId, s.featureId)!.properties['material'];
  })).toBe('Acero');

  await page.mouse.click(mid.x, mid.y);
  await page.keyboard.press('Delete');
  await expect.poll(() => featureCount(page, 'red_abastecimiento')).toBe(2);
  await expect(page.locator('me-layer-panel .badge.deleted')).toHaveText('−1');
});

test('descarga la capa en su formato y CRS originales', async ({ page }) => {
  await loadSample(page, 'red_abastecimiento.geojson');
  await page.locator('me-layer-panel button[aria-label="Descargar capa"]').click();
  await expect(page.locator('me-export-dialog')).toContainText('Descargar «red_abastecimiento»');
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('me-export-dialog button.primary').click()]);
  expect(download.suggestedFilename()).toBe('red_abastecimiento.geojson');
  const text = readFileSync((await download.path())!, 'utf8');
  const fc = JSON.parse(text);
  expect(fc.crs.properties.name).toBe('urn:ogc:def:crs:EPSG::25830');
  expect(fc.features[0].geometry.coordinates[0][0]).toBeCloseTo(440000, 2);
  expect(fc.features[0].geometry.coordinates[0][2]).toBe(650);
});

test('exporta GeoPackage y vuelve a leerlo', async ({ page }) => {
  await loadSample(page, 'hidrantes.gpkg');
  const res = await page.evaluate(async () => {
    const l = window.editor.getLayers()[0]!;
    const out = await window.editor.exportLayer(l.id);
    const layers = await window.editor.loadFiles([{ name: 'copia.gpkg', data: out.data }], { zoom: false });
    return { name: out.fileName, crs: layers[0]!.source.crs, z: layers[0]!.source.hasZ, n: window.editor.store.featureCount(layers[0]!.id) };
  });
  expect(res).toEqual({ name: 'hidrantes.gpkg', crs: 'EPSG:25830', z: true, n: 2 });
});

test('recupera la sesión autoguardada tras recargar', async ({ page }) => {
  await loadSample(page, 'red_abastecimiento.geojson');
  await focusOn(page, 440100, 4474000);
  const mid = await toScreen(page, await utm(page, 440100, 4474000));
  await page.mouse.click(mid.x, mid.y);
  const saved = page.evaluate(() => new Promise((r) => window.editor.on('autosaved', r)));
  await page.keyboard.press('Delete');
  await saved;

  await page.reload();
  await page.waitForSelector('body[data-ready=true]');
  const banner = page.locator('map-editor .banner');
  await expect(banner).toContainText('1 capa, 1 cambio');
  await banner.locator('button.primary').click();
  await expect(page.locator('me-layer-panel li')).toHaveCount(1);
  await expect(page.locator('me-layer-panel .badge.deleted')).toHaveText('−1');
  // El historial también se recupera
  await page.locator('me-toolbar button[aria-label="Deshacer"]').click();
  await expect.poll(() => featureCount(page, 'red_abastecimiento')).toBe(3);
});

test('al recuperar la sesión se recupera también la ubicación y el zoom', async ({ page }) => {
  await loadSample(page, 'red_abastecimiento.geojson');
  await page.evaluate(() => {
    window.editor.map.jumpTo({ center: [-3.55, 40.33], zoom: 13.37, bearing: 20, pitch: 0 });
    return new Promise((r) => window.editor.map.once('idle', r));
  });
  await page.evaluate(() => window.editor.flushSession());

  await page.reload();
  await page.waitForSelector('body[data-ready=true]');
  // Antes de recuperar, el mapa está en su vista inicial
  expect(await page.evaluate(() => window.editor.map.getZoom())).toBeLessThan(6);
  await page.locator('map-editor .banner button.primary').click();
  await expect(page.locator('me-layer-panel li')).toHaveCount(1);
  const v = await page.evaluate(() => ({ c: window.editor.map.getCenter().toArray(), z: window.editor.map.getZoom(), b: window.editor.map.getBearing() }));
  expect(v.c[0]).toBeCloseTo(-3.55, 4);
  expect(v.c[1]).toBeCloseTo(40.33, 4);
  expect(v.z).toBeCloseTo(13.37, 2);
  expect(v.b).toBeCloseTo(20, 1);
});

test('una sesión guardada sin vista (versión anterior) encuadra las capas al recuperarla', async ({ page }) => {
  await loadSample(page, 'red_abastecimiento.geojson');
  await page.evaluate(() => window.editor.flushSession());
  // Simular una sesión antigua: sin la vista ligera ni la incluida en la sesión
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('map-editor');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction('sessions', 'readwrite');
          const st = tx.objectStore('sessions');
          st.delete('demo::view');
          const get = st.get('demo');
          get.onsuccess = () => {
            const s = get.result as { view?: unknown };
            delete s.view;
            st.put(s, 'demo');
          };
          tx.oncomplete = () => (db.close(), resolve());
          tx.onerror = () => reject(tx.error);
        };
      }),
  );
  await page.reload();
  await page.waitForSelector('body[data-ready=true]');
  await page.locator('map-editor .banner button.primary').click();
  await expect.poll(() => page.evaluate(() => window.editor.map.getZoom())).toBeGreaterThan(14);
  const c = await page.evaluate(() => window.editor.map.getCenter().toArray());
  expect(c[0]).toBeCloseTo(-3.7059, 2);
  expect(c[1]).toBeCloseTo(40.414, 2);
});

test('cambia el mapa base sin perder las capas', async ({ page }) => {
  await loadSample(page, 'parcelas.zip');
  await page.locator('me-basemap-switcher button.trigger').click();
  await page.locator('me-basemap-switcher button', { hasText: 'PNOA Máxima Actualidad' }).click();
  await expect.poll(() => page.evaluate(() => window.editor.getBasemap())).toBe('ign-pnoa');
  await page.evaluate(() => new Promise((r) => window.editor.map.once('idle', r)));
  const ok = await page.evaluate(() => {
    const l = window.editor.getLayers()[0]!;
    return !!window.editor.map.getLayer(`me-${l.id}-fill`) && !!window.editor.map.getLayer('basemap-0');
  });
  expect(ok).toBe(true);
});

test('atajos de teclado con el foco en un panel y mover entidad con Ctrl+Z', async ({ page }) => {
  await loadSample(page, 'hidrantes.gpkg');
  await page.locator('me-layer-panel .name').first().click();
  await page.keyboard.press('m');
  await expect.poll(() => page.evaluate(() => window.editor.getTool())).toBe('move');
  // El botón «Tabla» desaparece al pulsarlo y el foco vuelve a <body>: los atajos deben seguir funcionando
  await page.locator('map-editor button', { hasText: 'Tabla' }).click();
  await page.keyboard.press('p'); // la capa activa es de puntos
  await expect.poll(() => page.evaluate(() => window.editor.getTool())).toBe('draw-point');
  await page.keyboard.press('m');

  await focusOn(page, 440200, 4474150);
  const p = await toScreen(page, await utm(page, 440200, 4474150));
  const before = await page.evaluate(() => JSON.stringify(window.editor.store.getFeatures(window.editor.getLayers()[0]!.id)[0]!.geometry));
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x - 80, p.y + 60, { steps: 5 });
  await page.mouse.up();
  const after = await page.evaluate(() => window.editor.store.getFeatures(window.editor.getLayers()[0]!.id)[0]!.geometry as { coordinates: number[] });
  expect(JSON.stringify(after)).not.toBe(before);
  expect(after.coordinates[2]).toBe(651.4); // mover en planta conserva la cota
  await page.keyboard.press('Control+z');
  await expect.poll(() => page.evaluate(() => JSON.stringify(window.editor.store.getFeatures(window.editor.getLayers()[0]!.id)[0]!.geometry))).toBe(before);
});

test('las herramientas de dibujo solo aparecen si la capa activa es de ese tipo', async ({ page }) => {
  const draw = (label: string) => page.locator(`me-toolbar button[aria-label="${label}"]`);
  const expectOnly = async (only: 'Dibujar punto' | 'Dibujar línea' | 'Dibujar polígono') => {
    for (const l of ['Dibujar punto', 'Dibujar línea', 'Dibujar polígono']) await expect(draw(l)).toHaveCount(l === only ? 1 : 0);
  };
  await loadSample(page, 'red_abastecimiento.geojson');
  await expectOnly('Dibujar línea');
  await loadSample(page, 'parcelas.zip');
  await expectOnly('Dibujar polígono');
  await loadSample(page, 'hidrantes.gpkg');
  await expectOnly('Dibujar punto');
  await expect(page.locator('me-toolbar button[aria-label="Seleccionar y editar vértices"]')).toHaveCount(1);
  await expect(page.locator('me-toolbar button[aria-label="Mover entidades"]')).toHaveCount(1);

  // Con la herramienta de punto activa, cambiar a una capa de líneas devuelve a «Seleccionar»
  await page.evaluate(() => window.editor.setTool('draw-point'));
  await page.evaluate(() => window.editor.setActiveLayer(window.editor.getLayers().find((l) => l.name === 'red_abastecimiento')!.id));
  await expect.poll(() => page.evaluate(() => window.editor.getTool())).toBe('select');
  await expectOnly('Dibujar línea');

  // El núcleo también lo exige (atajos, API): se rechaza con un aviso
  const msg = page.evaluate(() => new Promise<string>((r) => window.editor.on('message', (m) => r(m.text))));
  await page.evaluate(() => window.editor.setTool('draw-polygon'));
  expect(await page.evaluate(() => window.editor.getTool())).toBe('select');
  expect(await msg).toContain('necesita una capa activa de polígonos');

  // Una capa bloqueada no admite dibujo
  await page.evaluate(() => window.editor.updateLayer(window.editor.getActiveLayerId()!, { editable: false }));
  await expect(draw('Dibujar línea')).toHaveCount(0);
  // Sin capa activa tampoco
  await page.evaluate(() => window.editor.setActiveLayer(null));
  for (const l of ['Dibujar punto', 'Dibujar línea', 'Dibujar polígono']) await expect(draw(l)).toHaveCount(0);
  expect(await page.evaluate(() => window.editor.getAvailableTools())).toEqual(['select', 'move', 'vertices']);
});

test('capa nueva enganchada a elementos 3D: pasa a 3D y el snap sobre lo dibujado devuelve Z', async ({ page }) => {
  await loadSample(page, 'red_abastecimiento.geojson');
  await focusOn(page, 440200, 4474000);
  const newLayer = await page.evaluate(() => window.editor.createLayer('nueva', 'LineString').id);
  expect(await page.evaluate((id) => window.editor.getLayer(id)!.source.hasZ, newLayer)).toBe(false);

  await page.locator('me-toolbar button[aria-label="Dibujar línea"]').click();
  const a = await toScreen(page, await utm(page, 440200, 4474000));
  const b = await toScreen(page, await utm(page, 440250, 4473930));
  const c = await toScreen(page, await utm(page, 440300, 4473900));
  await page.mouse.move(a.x + 4, a.y + 3);
  await page.mouse.click(a.x + 4, a.y + 3); // snap a un vértice con Z = 650
  await page.mouse.click(b.x, b.y); // libre
  await page.mouse.dblclick(c.x, c.y); // libre

  const saved = await page.evaluate((id) => {
    const f = window.editor.store.getFeatures(id).at(-1)!;
    return { hasZ: window.editor.getLayer(id)!.source.hasZ, coords: (f.geometry as unknown as { coordinates: number[][] }).coordinates };
  }, newLayer);
  expect(saved.hasZ).toBe(true);
  expect(saved.coords.map((p) => p.length)).toEqual([3, 3, 3]);
  expect(saved.coords.map((p) => p[2])).toEqual([650, 650, 650]); // los libres continúan a la cota del enganchado

  // El snap sobre la arista de la línea nueva reconoce su Z
  await page.evaluate(() => {
    window.editor.on('pointer-move', (e) => ((window as unknown as { snapSeen: unknown }).snapSeen = e.snap));
  });
  const mid = await toScreen(page, await utm(page, 440225, 4473965));
  await page.mouse.move(mid.x, mid.y);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { snapSeen: { layerId: string; coord: number[] } | null }).snapSeen))
    .toMatchObject({ layerId: newLayer });
  const seen = await page.evaluate(() => (window as unknown as { snapSeen: { coord: number[] } }).snapSeen);
  expect(seen.coord[2]).toBe(650);
});

test('capa 3D: los vértices libres no recuperan Z=0 y se puede fijar la Z por defecto', async ({ page }) => {
  await loadSample(page, 'red_abastecimiento.geojson');
  await focusOn(page, 440200, 4474000);
  const layerId = await page.evaluate(() => window.editor.getActiveLayerId()!);
  const lastZ = () =>
    page.evaluate((id) => (window.editor.store.getFeatures(id).at(-1)!.geometry as unknown as { coordinates: number[][] }).coordinates.map((p) => p[2]), layerId);

  // Empieza libre y termina enganchado: los vértices iniciales toman la cota del enganchado
  await page.locator('me-toolbar button[aria-label="Dibujar línea"]').click();
  const p1 = await toScreen(page, await utm(page, 440120, 4473900));
  const p2 = await toScreen(page, await utm(page, 440150, 4473940));
  const p3 = await toScreen(page, await utm(page, 440200, 4474000));
  await page.mouse.click(p1.x, p1.y);
  await page.mouse.click(p2.x, p2.y);
  await page.mouse.move(p3.x + 3, p3.y + 3);
  await page.mouse.dblclick(p3.x + 3, p3.y + 3);
  await expect.poll(lastZ).toEqual([650, 650, 650]);

  // Sin nada a lo que engancharse se usa la Z por defecto de la capa
  const z = page.locator('me-layer-panel input[aria-label="Z por defecto de los vértices nuevos"]');
  await z.fill('12.5');
  await z.blur();
  await expect.poll(() => page.evaluate((id) => window.editor.getLayer(id)!.defaultZ, layerId)).toBe(12.5);
  await page.locator('me-toolbar button[aria-label="Dibujar línea"]').click();
  const q1 = await toScreen(page, await utm(page, 440300, 4473880));
  const q2 = await toScreen(page, await utm(page, 440330, 4473860));
  await page.mouse.click(q1.x, q1.y);
  await page.mouse.dblclick(q2.x, q2.y);
  await expect.poll(lastZ).toEqual([12.5, 12.5]);
});

/** Selecciona la tubería T-001 (3 vértices) de la red de ejemplo y abre la tabla de vértices. */
async function openVertexTable(page: Page) {
  await loadSample(page, 'red_abastecimiento.geojson');
  await focusOn(page, 440100, 4474000, 15);
  const mid = await toScreen(page, await utm(page, 440100, 4474000));
  await page.mouse.click(mid.x, mid.y);
  await expect(page.locator('me-attribute-panel input[aria-label="codigo"]')).toHaveValue('T-001');
  await page.locator('me-toolbar button[aria-label="Tabla de vértices"]').click();
  await expect(page.locator('me-vertex-table tbody tr')).toHaveCount(3);
}

/** Vértice de la entidad seleccionada, en ETRS89 / UTM 30N. */
const vertexUtm = (page: Page, i: number) =>
  page.evaluate((idx) => {
    const s = window.editor.getSelection()[0]!;
    const g = window.editor.store.getFeature(s.layerId, s.featureId)!.geometry as unknown as { coordinates: number[][] };
    const c = g.coordinates[idx]!;
    const u = window.mapEditorCore.transformGeometry({ type: 'Point', coordinates: [c[0]!, c[1]!] }, 'EPSG:4326', 'EPSG:25830') as unknown as { coordinates: number[] };
    return { x: u.coordinates[0]!, y: u.coordinates[1]!, z: c[2] };
  }, i);

test('tabla de vértices: muestra las coordenadas de la capa y las edita con deshacer', async ({ page }) => {
  await openVertexTable(page);
  const row = (n: number) => page.locator('me-vertex-table tbody tr').nth(n - 1);
  const input = (n: number, axis: string) => row(n).locator(`input[aria-label^="${axis} del vértice ${n}"]`);

  // Coordenadas en el CRS de la capa (ETRS89 / UTM 30N), con su cota
  await expect(page.locator('me-vertex-table select[aria-label="Sistema de coordenadas"]')).toContainText('EPSG:25830');
  await expect(input(1, 'X')).toHaveValue('440000.000');
  await expect(input(1, 'Y')).toHaveValue('4474000.000');
  await expect(input(1, 'Z')).toHaveValue('650.000');
  await expect(input(3, 'Z')).toHaveValue('649.500');
  // Información: tipo y distancias (horizontales, en metros)
  await expect(row(1).locator('td.info').nth(0)).toHaveText('Extremo');
  await expect(row(2).locator('td.info').nth(0)).toHaveText('Vértice');
  const d = async (n: number, col: number) => Number.parseFloat((await row(n).locator('td.info').nth(col).innerText()).replace(',', '.'));
  expect(await d(2, 1)).toBeGreaterThan(199);
  expect(await d(2, 1)).toBeLessThan(201);
  expect(await d(3, 2)).toBeGreaterThan(349); // distancia acumulada
  expect(await d(3, 2)).toBeLessThan(351);

  const original = await page.evaluate(() => {
    const s = window.editor.getSelection()[0]!;
    return JSON.stringify(window.editor.store.getFeature(s.layerId, s.featureId)!.geometry);
  });

  // Editar solo X: Y y Z no cambian
  await input(1, 'X').fill('440010.5');
  await input(1, 'X').blur();
  await expect.poll(async () => (await vertexUtm(page, 0)).x).toBeCloseTo(440010.5, 3);
  const v0 = await vertexUtm(page, 0);
  expect(v0.y).toBeCloseTo(4474000, 3);
  expect(v0.z).toBe(650);
  await expect(page.locator('me-layer-panel .badge.modified')).toHaveText('~1');

  // Editar la cota
  await input(3, 'Z').fill('700');
  await input(3, 'Z').blur();
  await expect.poll(async () => (await vertexUtm(page, 2)).z).toBe(700);

  // Un valor que no es un número se descarta
  await input(2, 'Y').fill('');
  await input(2, 'Y').blur();
  await expect(input(2, 'Y')).toHaveValue('4474000.000');

  // Cada edición es una transacción: se deshacen una a una
  await page.evaluate(() => window.editor.undo());
  await page.evaluate(() => window.editor.undo());
  expect(
    await page.evaluate(() => {
      const s = window.editor.getSelection()[0]!;
      return JSON.stringify(window.editor.store.getFeature(s.layerId, s.featureId)!.geometry);
    }),
  ).toBe(original);
  await expect(input(1, 'X')).toHaveValue('440000.000');
});

test('tabla de vértices: insertar, borrar y localizar un vértice', async ({ page }) => {
  await openVertexTable(page);
  const rows = page.locator('me-vertex-table tbody tr');

  // Insertar después del 1: el nuevo queda en el punto medio del segmento, con su cota
  await page.locator('me-vertex-table button[aria-label^="Insertar vértice después del 1"]').click();
  await expect(rows).toHaveCount(4);
  const mid = await vertexUtm(page, 1);
  expect(mid.x).toBeCloseTo(440100, 1);
  expect(mid.y).toBeCloseTo(4474000, 1);
  expect(mid.z).toBe(650);
  await expect(rows.nth(1)).toHaveClass(/active/); // el nuevo vértice queda marcado
  // El último vértice de una línea no tiene segmento a continuación
  await expect(page.locator('me-vertex-table button[aria-label^="Insertar vértice después del 4"]')).toBeDisabled();

  // Borrar el recién insertado
  await page.locator('me-vertex-table button[aria-label^="Borrar vértice 2"]').click();
  await expect(rows).toHaveCount(3);
  await page.evaluate(() => window.editor.undo());
  await expect(rows).toHaveCount(4);
  await page.evaluate(() => window.editor.undo());
  await expect(rows).toHaveCount(3);

  // No se puede dejar una línea con menos de 2 vértices
  await page.locator('me-vertex-table button[aria-label^="Borrar vértice 3"]').click();
  await expect(rows).toHaveCount(2);
  const msg = page.evaluate(() => new Promise<string>((r) => window.editor.on('message', (m) => r(m.text))));
  await page.locator('me-vertex-table button[aria-label^="Borrar vértice 2"]').click();
  expect(await msg).toContain('muy pocos vértices');
  await expect(rows).toHaveCount(2);

  // Localizar: «Ir al vértice» marca la fila y acerca el mapa
  await page.evaluate(() => window.editor.undo());
  await expect(rows).toHaveCount(3);
  await page.locator('me-vertex-table button[aria-label^="Ir al vértice 3"]').click();
  expect(await page.evaluate(() => window.editor.getEditState().activeVertexPath)).toEqual([2]);
  await expect.poll(() => page.evaluate(() => window.editor.map.getZoom())).toBeGreaterThanOrEqual(17);
});

test('tabla de vértices: se sincroniza con el vértice que se toca en el mapa', async ({ page }) => {
  await openVertexTable(page);
  const rows = page.locator('me-vertex-table tbody tr');
  await focusOn(page, 440200, 4474000, 17);
  const v2 = await toScreen(page, await utm(page, 440200, 4474000));
  await page.mouse.click(v2.x, v2.y); // tocar el vértice 2 sin arrastrarlo
  await expect(rows.nth(1)).toHaveClass(/active/);
  expect(await page.evaluate(() => window.editor.getEditState().activeVertexPath)).toEqual([1]);

  // Elegir una fila marca el vértice en el mapa (asa resaltada)
  await rows.nth(2).locator('td.num').click();
  await expect(rows.nth(2)).toHaveClass(/active/);
  await expect
    .poll(() => page.evaluate(() => window.editor.map.queryRenderedFeatures({ layers: ['me-overlay-vertex'] }).filter((f) => f.properties?.['active']).length))
    .toBe(1);

  // Seleccionar otra cosa vacía la tabla; cerrarla vuelve a «Seleccionar»
  await page.evaluate(() => window.editor.setSelection([]));
  await expect(page.locator('me-vertex-table')).toContainText('Selecciona una entidad');
  await page.locator('me-vertex-table button[aria-label="Cerrar tabla de vértices"]').click();
  await expect(page.locator('me-vertex-table')).toHaveCount(0);
  expect(await page.evaluate(() => window.editor.getTool())).toBe('select');
});

test('tabla de vértices: WGS84 y capa bloqueada (solo lectura)', async ({ page }) => {
  await openVertexTable(page);
  const x1 = page.locator('me-vertex-table tbody tr').first().locator('input').first();
  await page.locator('me-vertex-table select[aria-label="Sistema de coordenadas"]').selectOption('wgs84');
  await expect(page.locator('me-vertex-table thead')).toContainText('Lon');
  await expect(x1).toHaveValue(/^-3\.70\d{5}$/); // 7 decimales
  // Editar la latitud directamente en grados
  const y1 = page.locator('me-vertex-table tbody tr').first().locator('input').nth(1);
  await y1.fill('40.41');
  await y1.blur();
  await expect.poll(() => page.evaluate(() => {
    const s = window.editor.getSelection()[0]!;
    return (window.editor.store.getFeature(s.layerId, s.featureId)!.geometry as unknown as { coordinates: number[][] }).coordinates[0]![1];
  })).toBeCloseTo(40.41, 9);

  // Con la capa bloqueada se puede consultar y localizar, pero no editar
  await page.evaluate(() => window.editor.updateLayer(window.editor.getSelection()[0]!.layerId, { editable: false }));
  await expect(page.locator('me-vertex-table .badge.ro')).toHaveText('Solo lectura');
  await expect(x1).toBeDisabled();
  await expect(page.locator('me-vertex-table button[aria-label^="Borrar vértice"]')).toHaveCount(0);
  await expect(page.locator('me-vertex-table button[aria-label^="Insertar vértice"]')).toHaveCount(0);
  await page.locator('me-vertex-table tbody tr').nth(1).locator('td.num').click();
  await expect(page.locator('me-vertex-table tbody tr').nth(1)).toHaveClass(/active/);
  expect(await page.evaluate(() => window.editor.updateVertex(window.editor.getSelection()[0]!.layerId, window.editor.getSelection()[0]!.featureId, [0], { x: 1 }))).toBe(false);
});

test('los paneles de capas y de atributos tienen cada uno su propio scroll', async ({ page }) => {
  await ready(page);
  await page.setViewportSize({ width: 1200, height: 620 });
  await page.evaluate(() => {
    for (let i = 1; i <= 12; i++) window.editor.createLayer(`Capa de ejemplo ${i}`, 'Point');
    const fields = Array.from({ length: 40 }, (_, i) => ({ name: `campo_${i + 1}`, type: 'string' as const }));
    const layer = window.editor.createLayer('Datos', 'Point', { fields });
    const id = window.editor.store.transact('x', (tx) => tx.add(layer.id, { type: 'Point', coordinates: [-3.7, 40.4] }, {}));
    window.editor.setSelection([{ layerId: layer.id, featureId: id }]);
  });
  await expect(page.locator('me-attribute-panel input[aria-label="campo_1"]')).toBeVisible();

  const m = await page.evaluate(() => {
    const root = document.querySelector('map-editor')!.shadowRoot!;
    const side = root.querySelector('.side')!;
    const layers = root.querySelector('me-layer-panel')!;
    const attrs = root.querySelector('me-attribute-panel')!;
    const ul = layers.shadowRoot!.querySelector('ul')!;
    const wrap = attrs.shadowRoot!.querySelector('.wrap')!;
    const before = { ul: ul.scrollTop, wrap: wrap.scrollTop };
    wrap.scrollTop = 120;
    const after = { ul: ul.scrollTop, wrap: wrap.scrollTop };
    ul.scrollTop = 50;
    const lr = layers.getBoundingClientRect();
    const ar = attrs.getBoundingClientRect();
    return {
      sideScrolls: side.scrollHeight > side.clientHeight + 1,
      ulOverflows: ul.scrollHeight > ul.clientHeight + 1,
      wrapOverflows: wrap.scrollHeight > wrap.clientHeight + 1,
      before,
      after,
      wrapAfterUl: wrap.scrollTop,
      disjoint: lr.bottom <= ar.top + 1,
      inViewport: ar.bottom <= innerHeight && lr.top >= 0,
    };
  });
  expect(m.sideScrolls).toBe(false); // el contenedor no se desplaza: lo hace cada panel
  expect(m.ulOverflows).toBe(true);
  expect(m.wrapOverflows).toBe(true);
  expect(m.after.wrap).toBeGreaterThan(0);
  expect(m.after.ul).toBe(0); // desplazar atributos no mueve las capas
  expect(m.wrapAfterUl).toBe(m.after.wrap); // y al revés
  expect(m.disjoint).toBe(true);
  expect(m.inViewport).toBe(true);
});

declare global {
  interface Window {
    editor: import('@map-editor/core').MapEditor;
    mapEditorCore: typeof import('@map-editor/core');
  }
}
