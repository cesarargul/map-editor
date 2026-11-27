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
  expect(await page.evaluate(() => window.editor.getAvailableTools())).toEqual(['select', 'move']);
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

declare global {
  interface Window {
    editor: import('@map-editor/core').MapEditor;
    mapEditorCore: typeof import('@map-editor/core');
  }
}
