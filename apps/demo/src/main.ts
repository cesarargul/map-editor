import * as core from '@map-editor/web-component';
import { setMapLibreWorkerUrl, type MapEditor } from '@map-editor/web-component';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';

// MapLibre 6 carga su worker desde un fichero aparte: con un bundler hay que indicar su URL.
setMapLibreWorkerUrl(workerUrl);

const el = document.querySelector('map-editor')!;

// Accesible desde la consola y desde las pruebas e2e
el.whenReady.then((editor: MapEditor) => {
  Object.assign(window, { editor, mapEditorCore: core });
  document.body.dataset['ready'] = 'true';
});

for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-sample]')) {
  btn.addEventListener('click', async () => {
    const name = btn.dataset['sample']!;
    const res = await fetch(new URL(`samples/${name}`, document.baseURI));
    const file = new File([await res.arrayBuffer()], name);
    await el.loadFiles([file]);
  });
}
