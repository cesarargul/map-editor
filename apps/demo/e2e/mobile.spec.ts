import { devices, expect, test } from '@playwright/test';

const { defaultBrowserType: _ignored, ...pixel } = devices['Pixel 7']!;
test.use(pixel);

test('móvil: se ve el aviso de carga al abrir ficheros desde el panel y al recuperar la sesión', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('body[data-ready=true]');
  await page.locator('map-editor button[aria-label="Paneles"]').tap();
  // Escuchar el autoguardado antes de cargar nada, para no perderse el evento
  await page.evaluate(() => {
    (window as unknown as { saved: Promise<unknown> }).saved = new Promise((r) => window.editor.on('autosaved', r));
  });

  const busy = page.locator('map-editor .busy');
  await page.locator('me-layer-panel input[type=file]').setInputFiles(new URL('../public/samples/red_abastecimiento.geojson', import.meta.url).pathname);
  await expect(busy).toBeVisible();
  await expect(busy).toContainText('Leyendo ficheros');
  await expect(busy).toBeHidden();
  await expect(page.locator('me-layer-panel li')).toHaveCount(1);

  // Recuperar la sesión guardada tras recargar
  await page.evaluate(() => (window as unknown as { saved: Promise<unknown> }).saved);
  await page.reload();
  await page.waitForSelector('body[data-ready=true]');
  await page.locator('map-editor .banner button.primary').tap();
  await expect(busy).toBeVisible();
  await expect(busy).toContainText('Recuperando la sesión');
  await expect(busy).toBeHidden();
});

test('móvil: tabla con muchos campos (scroll lateral y X visible) y nombres largos completos', async ({ page, context }) => {
  await page.goto('/');
  await page.waitForSelector('body[data-ready=true]');
  const longName = 'Red de abastecimiento de agua potable del municipio – tramo norte (ampliación 2026)';
  await page.evaluate((name) => {
    const fields = Array.from({ length: 30 }, (_, i) => ({ name: `campo_largo_numero_${i + 1}`, type: 'string' as const }));
    const layer = window.editor.createLayer(name, 'Point', { fields });
    const props = Object.fromEntries(fields.map((f) => [f.name, `valor ${f.name}`]));
    window.editor.store.transact('prueba', (tx) => void tx.add(layer.id, { type: 'Point', coordinates: [-3.7, 40.4] }, props));
  }, longName);
  const vp = page.viewportSize()!.width;

  // Nombre de capa: se ajusta a varias líneas, sin recortes, y las acciones caben en la pantalla
  await page.locator('map-editor button[aria-label="Paneles"]').tap();
  const name = await page.locator('me-layer-panel li .name').first().evaluate((el) => {
    const cs = getComputedStyle(el);
    return { clippedX: el.scrollWidth > el.clientWidth + 1, clippedY: el.scrollHeight > el.clientHeight + 1, ellipsis: cs.textOverflow === 'ellipsis', wraps: cs.whiteSpace !== 'nowrap', height: el.getBoundingClientRect().height, line: parseFloat(cs.lineHeight) || 16 };
  });
  expect(name).toMatchObject({ clippedX: false, clippedY: false, ellipsis: false, wraps: true });
  expect(name.height).toBeGreaterThan(name.line * 2); // ocupa varias líneas
  for (const b of await page.locator('me-layer-panel li .actions button').all()) {
    const box = (await b.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(vp);
  }

  // Tabla: ocupa el ancho de la pantalla, hace scroll lateral con el dedo y la X se ve
  await page.locator('map-editor button', { hasText: 'Tabla' }).tap();
  const close = page.locator('me-attribute-table button[aria-label="Cerrar tabla"]');
  await expect(close).toBeInViewport();
  const scroll = page.locator('me-attribute-table .scroll');
  const dims = () => scroll.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, left: el.scrollLeft }));
  const d0 = await dims();
  expect(d0.cw).toBeLessThanOrEqual(vp);
  expect(d0.sw).toBeGreaterThan(d0.cw * 2);

  const box = (await scroll.boundingBox())!;
  const y = box.y + box.height / 2;
  const cdp = await context.newCDPSession(page);
  const touch = (type: string, x = 0) => cdp.send('Input.dispatchTouchEvent', { type: type as 'touchStart', touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  await touch('touchStart', vp - 40);
  for (let i = 1; i <= 10; i++) await touch('touchMove', vp - 40 - i * 32);
  await touch('touchEnd');
  await expect.poll(async () => (await dims()).left).toBeGreaterThan(100);
  // Esperar a que acabe la inercia del gesto: un toque durante ella solo la detiene
  await expect
    .poll(async () => {
      const a = (await dims()).left;
      await page.waitForTimeout(200);
      return a === (await dims()).left;
    })
    .toBe(true);

  await close.tap();
  await expect(page.locator('me-attribute-table')).toHaveCount(0);
});

test('móvil: los atributos aparecen al seleccionar una entidad, se pueden cerrar y el botón de paneles no tapa la brújula', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('body[data-ready=true]');
  await page.tap('[data-sample="red_abastecimiento.geojson"]');
  await page.waitForFunction(() => window.editor.getLayers().length === 1);
  const attrs = page.locator('me-attribute-panel');
  const select = (on: boolean) =>
    page.evaluate((o) => {
      const l = window.editor.getLayers()[0]!;
      const f = window.editor.store.getFeatures(l.id)[0]!;
      window.editor.setSelection(o ? [{ layerId: l.id, featureId: f.id }] : []);
    }, on);

  // Sin selección no se muestra nada; el panel de capas sigue plegado
  await expect(attrs).toHaveCount(0);
  await expect(page.locator('me-layer-panel')).toHaveCount(0);
  await select(true);
  // Aparece plegada (solo la cabecera) para no tapar la entidad seleccionada
  await expect(attrs).toBeVisible();
  await expect(attrs).toContainText('red_abastecimiento');
  await expect(attrs.locator('input[aria-label="codigo"]')).toHaveCount(0);
  await expect(page.locator('me-layer-panel')).toHaveCount(0);
  // Se despliega y se vuelve a plegar
  await attrs.locator('button[aria-label="Mostrar atributos"]').tap();
  await expect(attrs.locator('input[aria-label="codigo"]')).toBeInViewport();
  await attrs.locator('button[aria-label="Ocultar atributos"]').tap();
  await expect(attrs.locator('input[aria-label="codigo"]')).toHaveCount(0);

  // Se cierra con la X y vuelve a salir con una selección nueva
  await attrs.locator('button[aria-label="Cerrar atributos"]').tap();
  await expect(attrs).toHaveCount(0);
  await select(false);
  await select(true);
  await expect(attrs).toBeVisible();

  // No aparece mientras se dibuja
  await page.evaluate(() => window.editor.setTool('draw-line'));
  await expect(attrs).toHaveCount(0);
  await page.evaluate(() => window.editor.setTool('select'));
  await expect(attrs).toBeVisible();

  // Con las capas abiertas, cada panel conserva su sitio (el de capas encima)
  await page.locator('map-editor button[aria-label="Paneles"]').tap();
  await expect(page.locator('me-layer-panel')).toBeVisible();
  const boxes = await page.evaluate(() => {
    const root = document.querySelector('map-editor')!.shadowRoot!;
    const r = (el: Element | null) => el!.getBoundingClientRect();
    return {
      layers: r(root.querySelector('me-layer-panel')),
      attrs: r(root.querySelector('me-attribute-panel')),
      toggle: r(root.querySelector('.side-toggle')),
      compass: r(root.querySelector('.maplibregl-ctrl-compass')),
      vh: innerHeight,
    };
  });
  expect(boxes.layers.bottom).toBeLessThanOrEqual(boxes.attrs.top + 1);
  expect(boxes.attrs.bottom).toBeLessThanOrEqual(boxes.vh);
  expect(boxes.toggle.top).toBeGreaterThanOrEqual(boxes.compass.bottom - 1); // no tapa la brújula
});

test('móvil: tabla de vértices (editar coordenadas y ver la X de cierre)', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('body[data-ready=true]');
  await page.tap('[data-sample="red_abastecimiento.geojson"]');
  await page.waitForFunction(() => window.editor.getLayers().length === 1);
  await page.evaluate(() => {
    const l = window.editor.getLayers()[0]!;
    window.editor.setSelection([{ layerId: l.id, featureId: window.editor.store.getFeatures(l.id)[0]!.id }]);
  });
  await page.locator('me-toolbar button[aria-label="Tabla de vértices"]').tap();
  const table = page.locator('me-vertex-table');
  await expect(table.locator('tbody tr')).toHaveCount(3);
  // La hoja de atributos no se superpone con la tabla de vértices
  await expect(page.locator('me-attribute-panel')).toHaveCount(0);

  const vp = page.viewportSize()!.width;
  await expect(table.locator('button[aria-label="Cerrar tabla de vértices"]')).toBeInViewport();
  const dims = await table.locator('.scroll').evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
  expect(dims.cw).toBeLessThanOrEqual(vp);
  expect(dims.sw).toBeGreaterThan(dims.cw); // más columnas que ancho: se desliza en horizontal

  const z = table.locator('tbody tr').nth(1).locator('input[aria-label^="Z del vértice 2"]');
  await z.fill('655.25');
  await z.blur();
  await expect
    .poll(() => page.evaluate(() => {
      const s = window.editor.getSelection()[0]!;
      return (window.editor.store.getFeature(s.layerId, s.featureId)!.geometry as unknown as { coordinates: number[][] }).coordinates[1]![2];
    }))
    .toBe(655.25);

  await table.locator('button[aria-label="Cerrar tabla de vértices"]').tap();
  await expect(table).toHaveCount(0);
});

test('móvil: dibujar con toques, terminar con botón, arrastrar y borrar vértice', async ({ page, context }) => {
  if (process.env['CPU_THROTTLE']) {
    const c = await context.newCDPSession(page);
    await c.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env['CPU_THROTTLE']) });
  }
  await page.goto('/');
  await page.waitForSelector('body[data-ready=true]');
  await page.tap('[data-sample="red_abastecimiento.geojson"]');
  await page.waitForFunction(() => window.editor.getLayers().length === 1);
  await page.evaluate(() => new Promise((r) => window.editor.map.once('idle', r)));
  const count = () => page.evaluate(() => window.editor.store.featureCount(window.editor.getLayers()[0]!.id));

  // Los paneles empiezan plegados en pantallas pequeñas
  await expect(page.locator('me-layer-panel')).toHaveCount(0);

  await page.locator('me-toolbar button[aria-label="Dibujar línea"]').tap();
  for (const [x, y] of [[80, 600], [150, 650], [220, 610]] as const) await page.touchscreen.tap(x, y);
  const finish = page.locator('me-edit-actions button', { hasText: 'Terminar' });
  await expect(finish).toBeEnabled();
  await page.locator('me-edit-actions button', { hasText: 'Quitar vértice' }).tap();
  await finish.tap();
  await expect.poll(count).toBe(4);

  // Arrastrar el último vértice con el dedo
  await page.locator('me-toolbar button[aria-label="Seleccionar y editar vértices"]').tap();
  const v = await page.evaluate(() => {
    const s = window.editor.getSelection()[0]!;
    const g = window.editor.store.getFeature(s.layerId, s.featureId)!.geometry as unknown as { coordinates: [number, number][] };
    const r = document.querySelector('map-editor')!.shadowRoot!.querySelector('#map')!.getBoundingClientRect();
    const p = window.editor.map.project(g.coordinates[1]!);
    return { x: r.left + p.x, y: r.top + p.y, before: JSON.stringify(g) };
  });
  // Esperar a que el mapa haya pintado las asas de los vértices antes de tocarlas
  await page.waitForFunction(() => window.editor.map.queryRenderedFeatures({ layers: ['me-overlay-vertex'] }).length > 0);
  const cdp = await context.newCDPSession(page);
  const touch = (type: string, x = 0, y = 0) =>
    cdp.send('Input.dispatchTouchEvent', { type: type as 'touchStart', touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  await touch('touchStart', v.x, v.y);
  for (let i = 1; i <= 6; i++) {
    await touch('touchMove', v.x + i * 5, v.y + i * 8);
    await page.waitForTimeout(30);
  }
  await touch('touchEnd');
  const geom = () =>
    page.evaluate(() => {
      const s = window.editor.getSelection()[0]!;
      return JSON.stringify(window.editor.store.getFeature(s.layerId, s.featureId)!.geometry);
    });
  await expect.poll(geom).not.toBe(v.before);

  // Tocar el vértice lo activa; en una línea de 2 vértices, borrarlo debe avisar en lugar de romperla
  await page.touchscreen.tap(v.x + 30, v.y + 48);
  await page.locator('me-edit-actions button', { hasText: 'Borrar vértice' }).tap();
  await expect(page.locator('map-editor .toast', { hasText: 'muy pocos vértices' })).toBeVisible();
});
