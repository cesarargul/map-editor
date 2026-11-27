# Map Editor

Editor web de capas vectoriales sobre **MapLibre GL JS**, en **TypeScript**: arrastrar y soltar ficheros, editarlos con snapping configurable (con conectividad 3D por cota Z) y volver a descargarlos en su formato y sistema de referencia originales.

Se distribuye en tres paquetes, para usarlo en Angular o en cualquier otra aplicación:

| Paquete | Qué es | Cuándo usarlo |
|---|---|---|
| `@map-editor/core` | Núcleo *headless* (sin interfaz): mapa, edición, snapping, importación/exportación, autoguardado | Para construir una interfaz propia |
| `@map-editor/web-component` | `<map-editor>` (Lit) con interfaz completa | En cualquier framework o HTML plano |
| `@map-editor/angular` | `<me-map-editor>` standalone con signals (Angular ≥ 22.2) | En aplicaciones Angular |

El análisis y las decisiones de diseño están en [`docs/ANALISIS.md`](docs/ANALISIS.md).

## Estado: fase 1

- [x] Mapas base: OpenStreetMap (por defecto), OpenFreeMap vectorial, IGN Base, PNOA Máxima Actualidad, PNOA + rótulos, MTN y Mapa Base IGN vectorial
- [x] Arrastrar y soltar ficheros y carpetas: GeoJSON, Shapefile (sueltos o en ZIP), KML/KMZ, GPX, GeoPackage, FlatGeobuf; DXF, GML, CSV y otros con GDAL-WASM bajo demanda
- [x] Conserva el CRS original (p. ej. ETRS89 / UTM 30N) y la coordenada Z en la ida y vuelta; deduce UTM si el fichero no declara CRS
- [x] Seguimiento de cambios por entidad (nueva / modificada / borrada) y exportación completa o solo de cambios
- [x] Herramientas esenciales: seleccionar (clic, Mayús, rectángulo), dibujar punto/línea/polígono, editar vértices (mover, insertar, borrar), mover entidades, borrar, deshacer/rehacer, atributos (formulario, tabla y campos)
- [x] Snapping a vértice, extremo, arista, punto medio e intersección, con matriz configurable entre capas y tipos por capa
- [x] Snapping 3D: hereda la Z del vértice o la interpola en la arista; marca los cruces en planta que no coinciden en cota
- [x] Autoguardado en IndexedDB con recuperación de la sesión (incluido el historial de deshacer)
- [ ] Fase 2: grafo de conectividad 3D y herramientas de calidad/topología
- [ ] Fase 3: geometría avanzada (dividir, unir, rotar…) y productividad (copiar/pegar, medir…)
- [ ] Fase 4: WMS dinámicos, proxy CORS, catálogo recolectado con IA y buscador

## Demo en línea

https://cesarargul.github.io/map-editor/: se publica automáticamente en cada push a `main` (workflow `pages.yml`). Hay que activarla una vez en *Settings → Pages → Source: GitHub Actions*.

### En el móvil

- Tocar añade vértices. Mientras dibujas aparece una barra con **Terminar**, **Quitar vértice** y **Cancelar** (sustituyen al doble clic, a Intro, a Retroceso y a Esc).
- Con *Seleccionar*, toca una entidad y luego uno de sus vértices: puedes arrastrarlo con el dedo o borrarlo con **Borrar vértice** (sustituye a Alt+clic).
- En pantallas táctiles las asas son más grandes y la tolerancia del snapping y de la selección se duplica.
- En pantallas estrechas los paneles empiezan plegados (botón de capas, arriba a la derecha).

## Desarrollo

Requisitos: Node 22 y pnpm 10.

```bash
pnpm install
pnpm build          # core → web-component → angular
pnpm test           # pruebas unitarias del núcleo (Vitest)
pnpm dev            # demo en http://localhost:5173 (usa las fuentes, con recarga en caliente)
pnpm e2e            # pruebas en navegador de la demo (Playwright)
```

Hay dos aplicaciones de ejemplo:

- `apps/demo`: Vite + `<map-editor>`, con datos de ejemplo (red de abastecimiento 3D en UTM 30N, calles a otra cota, parcelas en Shapefile e hidrantes en GeoPackage). Para regenerarlos: `pnpm --filter @map-editor/core build && pnpm --filter demo samples`.
- `apps/angular-demo`: Angular 22 *zoneless* con `<me-map-editor>` (`pnpm --filter angular-demo build`).

## Uso

### HTML / cualquier framework (Web Component)

```bash
npm i @map-editor/web-component maplibre-gl
```

```html
<map-editor storage-key="mi-proyecto" basemap="osm" style="height: 600px"></map-editor>

<script type="module">
  import { setMapLibreWorkerUrl } from '@map-editor/web-component';
  // Vite: MapLibre 6 carga su worker desde un fichero aparte
  import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
  setMapLibreWorkerUrl(workerUrl);

  const el = document.querySelector('map-editor');
  el.addEventListener('editor-ready', (e) => {
    const editor = e.detail.editor; // API completa del núcleo
  });
</script>
```

Atributos: `basemap`, `center` (`"lon,lat"`), `zoom`, `storage-key`, `no-autosave`, `osm-tile-url`, `sql-wasm-url`, `gdal-path`, `worker-url`, `ui` (partes visibles: `toolbar layers attributes table basemaps status`) y `theme` (`light` | `dark`).
Propiedades: `snapping`, `basemaps` y `editor` (solo lectura). También `whenReady` (promesa) y `loadFiles(files)`.
Eventos: `editor-ready`, `editor-change`, `selection-change`, `layers-change` y `editor-message`.

El aspecto se personaliza con variables CSS: `--me-primary`, `--me-bg`, `--me-fg`, `--me-border`, `--me-radius`, `--me-font`…

### Angular

```bash
npm i @map-editor/angular @map-editor/web-component maplibre-gl sql.js
```

`angular.json` → copiar el worker de MapLibre y el wasm de sql.js:

```json
"assets": [
  { "glob": "maplibre-gl-worker.mjs", "input": "node_modules/maplibre-gl/dist", "output": "maplibre" },
  { "glob": "sql-wasm.wasm", "input": "node_modules/sql.js/dist", "output": "sqljs" }
],
"allowedCommonJsDependencies": ["jszip", "sql.js", "gdal3.js", "proj4"]
```

```ts
// main.ts
bootstrapApplication(App, {
  providers: [provideMapEditor({ workerUrl: '/maplibre/maplibre-gl-worker.mjs', sqlWasmUrl: '/sqljs/sql-wasm.wasm' })],
});
```

```ts
@Component({
  imports: [MapEditorComponent],
  template: `<me-map-editor storageKey="obras" (ready)="onReady($event)" (selectionChange)="sel.set($event)" />`,
})
export class Obras {
  private readonly mapEditor = viewChild.required(MapEditorComponent);
  readonly capas = computed(() => this.mapEditor().layers()); // también editor() y selection()
}
```

### Núcleo headless (interfaz propia)

```ts
import { MapEditor } from '@map-editor/core';

const editor = new MapEditor({ container: 'map', workerUrl, snapping: { tolerancePx: 10 } });
await editor.ready;

const [capa] = await editor.loadFiles(files);            // File[] o { name, data }[]
editor.setTool('draw-line');                              // select | draw-point | draw-line | draw-polygon | move
editor.on('selection-changed', ({ selection }) => …);
editor.setFeatureProperties(capa.id, featureId, { estado: 'revisado' });
editor.undo();
await editor.downloadLayer(capa.id);                      // mismo formato y CRS que el original
await editor.exportLayer(capa.id, { format: 'gpkg', crs: 'EPSG:25830', scope: 'changes' });
```

## Herramientas de dibujo y capa activa

Las herramientas de dibujo se dibujan siempre en la **capa activa** y solo están disponibles cuando esta es editable, visible y del tipo correspondiente: *punto* en capas de puntos, *línea* en capas de líneas y *polígono* en capas de polígonos (las capas de tipo mixto admiten las tres). La barra solo muestra las que sirven; si cambias de capa mientras dibujas, vuelve a *Seleccionar*. El núcleo lo exige también por API y atajos: `editor.getAvailableTools()`, `editor.isToolAvailable(id)` y el evento `available-tools-changed`.

## Cota Z al dibujar y editar

La Z de cada vértice nuevo se decide así, para que el snap la encuentre siempre:

- Si se engancha a un elemento con cota, hereda su Z (o la interpola en una arista).
- Si no, **continúa a la cota del vértice anterior**; los del principio toman la del primero enganchado. Si no hay ningún enganche, se usa la **Z por defecto** de la capa (campo «Z por defecto» del panel de capas, en capas 3D).
- Una capa **nueva** 2D que se engancha a elementos con cota pasa a 3D; una capa 2D **de fichero** descarta la cota (con un aviso).

## Operaciones largas

`editor.on('busy-changed', ({ busy, label }) => …)` avisa de que se están leyendo ficheros, recuperando la sesión o generando un fichero. `<map-editor>` lo muestra como un aviso con indicador de progreso (al menos 0,45 s, para que no parpadee).

## Snapping

```ts
editor.setSnapConfig({
  tolerancePx: 12,
  defaultTypes: ['vertex', 'endpoint', 'edge', 'midpoint', 'intersection'],
  defaultTargets: ['*'],                      // capas a las que engancharse si no hay regla
  rules: { tuberias: ['self', 'acometidas'] }, // capa que editas → capas destino
  targets: { parcelas: { types: ['vertex'], priority: 1 } },
  inheritZ: true,                              // heredar/interpolar la Z del destino
  zTolerance: 0.01,                            // misma cota = conectados en 3D
});
```

La configuración es JSON serializable. Desde la interfaz se edita con el botón ⚙ de la barra de herramientas.

## Atajos de teclado

| Tecla | Acción |
|---|---|
| V · P · L · G · M | Seleccionar · Punto · Línea · Polígono · Mover (P, L y G solo si la capa activa es de ese tipo) |
| S | Activar/desactivar snapping |
| Ctrl+Z · Ctrl+Y (Ctrl+Mayús+Z) | Deshacer · Rehacer |
| Supr / Retroceso | Borrar selección (en dibujo: quitar el último vértice) |
| Intro · doble clic | Terminar línea o polígono |
| Esc | Cancelar dibujo o arrastre · quitar selección |
| Mayús+clic · Mayús+arrastrar | Añadir a la selección · Selección por rectángulo |
| Alt+clic en vértice | Borrar vértice |

## Formatos

| Formato | Leer | Escribir | Notas |
|---|---|---|---|
| GeoJSON | ✅ | ✅ | Respeta el miembro `crs` (GeoJSON 2008) |
| Shapefile | ✅ | ✅ | Lector/escritor propio con Z; codificación por `.cpg` o deducida (UTF-8 / Windows-1252); un fichero por tipo de geometría si la capa es mixta |
| GeoPackage | ✅ | ✅ | sql.js (wasm, ~600 KB, se carga al usarse) |
| FlatGeobuf | ✅ | ✅ | |
| KML / KMZ | ✅ | ✅ | Siempre WGS84 |
| GPX | ✅ | ✅ | Puntos y tracks; sin polígonos |
| DXF, GML, CSV, MapInfo, DGN, FileGDB… | ✅ | DXF, GML, CSV | GDAL-WASM (~10 MB, solo si se necesita) |

## Limitaciones conocidas

- MapLibre es 2.5D: la Z se ve en la barra de estado, en el formulario de atributos y en los avisos de cruce, no como geometría en 3D.
- ED50 se transforma con parámetros aproximados (±1-2 m). Para precisión centimétrica hace falta la rejilla NTv2 del IGN.
- El autoguardado serializa todas las capas en cada guardado (con retardo de 1,5 s). Con capas de cientos de miles de entidades conviene desactivarlo o usar un `SessionStorage` propio.
- La política de uso de `tile.openstreetmap.org` no permite uso intensivo: en producción, configura `osm-tile-url` con un proveedor propio.
