import { devices, expect, test } from '@playwright/test';

const { defaultBrowserType: _ignored, ...pixel } = devices['Pixel 7']!;
test.use(pixel);

test('móvil: dibujar con toques, terminar con botón, arrastrar y borrar vértice', async ({ page, context }) => {
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
  const cdp = await context.newCDPSession(page);
  const touch = (type: string, x = 0, y = 0) =>
    cdp.send('Input.dispatchTouchEvent', { type: type as 'touchStart', touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  await touch('touchStart', v.x, v.y);
  for (let i = 1; i <= 6; i++) await touch('touchMove', v.x + i * 5, v.y + i * 8);
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
