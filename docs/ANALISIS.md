# Map Editor — Análisis y decisiones

Editor web de capas vectoriales sobre **MapLibre GL JS**, en **TypeScript**, reutilizable en Angular y en cualquier aplicación web.

## Decisiones tomadas

| Tema | Decisión |
|---|---|
| Distribución | Monorepo: `core` (TS sin framework, headless) + `web-component` (`<map-editor>`, Lit) + `angular` (envoltorio, Angular 22.2+) |
| Interfaz | Lit sobre core headless; cada pieza de la interfaz es sustituible |
| Motor de edición | Propio sobre eventos y fuentes de MapLibre (control total de Z, snapping, topología y deshacer) |
| Herramientas | Grupos A, B, C y D (ver abajo), implementados por fases |
| 3D | Conectividad con Z: conexión solo si coinciden XYZ dentro de tolerancia; grafo de red, extremos sueltos y cruces sin nodo |
| Formatos | GeoJSON, Shapefile, KML, GPX, GeoPackage y FlatGeobuf con librerías ligeras; GDAL-WASM bajo demanda para DXF, GML y otros. Conserva CRS original y Z |
| Persistencia | Autoguardado en IndexedDB (capas, cambios, historial) con recuperación |
| Fondos base | OSM raster por defecto (URL configurable) + OpenFreeMap vectorial + IGN: Mapa Base vectorial, IGN Base (WMTS), PNOA Máxima Actualidad, MTN raster |
| WMS dinámicos | Por URL (GetCapabilities 1.1.1/1.3.0) + WMTS; proxy CORS opcional configurable + Cloudflare Worker incluido |
| Catálogo WMS | GitHub Actions con cron semanal: recolector determinista + clasificación con la API de Claude → PR revisable |
| Publicación del catálogo | `catalog.json` + índice versionados en el repo, servidos por GitHub Pages/jsDelivr; URL configurable en el componente |
| Buscador | MiniSearch en el navegador (sin tildes, tolerante a errores), filtros por tema, organismo, CCAA, extensión, 3857 y CORS |

## Herramientas de edición

- **A · Esenciales:** seleccionar (clic, rectángulo, Shift), dibujar punto/línea/polígono, editar vértices, mover, borrar, deshacer/rehacer, atributos (formulario + tabla).
- **B · Geometría avanzada:** dividir línea, cortar polígono, unir, rotar/escalar, continuar e invertir línea.
- **C · Productividad:** copiar/pegar entre capas con mapeo de atributos, medir 2D/3D, entrada numérica de distancia/ángulo, offset/buffer.
- **D · Calidad/topología:** validación de geometrías, extremos sueltos, cruces sin nodo, edición topológica de vértices compartidos.

## Snapping

- Tipos: vértice, extremo, arista, punto medio, intersección.
- Matriz configurable «capa que edito → capas destino», con tolerancia en px, tipos activos y prioridad por capa (JSON serializable).
- Índice espacial `rbush` por capa con actualización incremental.
- Al hacer snap a un vértice se hereda su Z.

## Estructura

```
map-editor/
├─ packages/
│  ├─ core/            # API headless: mapa, edición, snapping, topología, I/O, WMS, catálogo
│  ├─ web-component/   # <map-editor> con Lit
│  └─ angular/         # componente standalone + servicio (signals)
├─ apps/demo/          # Vite
├─ catalog/            # recolector, clasificación IA, catalog.json, índice
├─ proxy/              # Cloudflare Worker para CORS
└─ .github/workflows/  # cron del catálogo, CI
```

## Fases

1. Núcleo, mapas base, arrastrar y soltar, importación/exportación, autoguardado, herramientas A y snapping configurable.
2. Conectividad con Z y herramientas D.
3. Herramientas B y C.
4. WMS dinámicos, proxy, catálogo con GitHub Actions + Claude y buscador.

## Catálogo WMS: proceso

```
Descubrir → Recolectar GetCapabilities → Normalizar → Enriquecer con IA → Comprobar salud → PR con catalog.json
```

- Fuentes: IDEE (directorio y CSW), datos.gob.es, Geoportal INSPIRE (España), IDE autonómicas, organismos (Catastro, CNIG, MITECO, IGME, AEMET, CHs…) y una lista semilla mantenida en el repo.
- Datos por capa: título, resumen, palabras clave, organismo, bbox, CRS, soporte 3857, CORS, formatos, estilos, latencia y estado.
- IA (API de Claude): clasificación por tema INSPIRE/organismo/ámbito, títulos y descripciones legibles, detección de duplicados.

## Riesgos

- WMS sin CORS o sin EPSG:3857 → proxy y marcado en el índice.
- Política de uso de `tile.openstreetmap.org` → URL configurable para producción.
- Pérdida de Z en librerías de terceros → tests de ida y vuelta por formato.
- Límites de Shapefile (nombres de campo de 10 caracteres, codificación) → avisos al exportar.
- Atribuciones obligatorias (IGN CC BY 4.0, OSM ODbL).
