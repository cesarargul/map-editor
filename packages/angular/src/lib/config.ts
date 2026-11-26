import { InjectionToken, makeEnvironmentProviders, type EnvironmentProviders } from '@angular/core';
import type { BasemapDef, SnapConfig } from '@map-editor/web-component';

/** Valores por defecto para todos los `<me-map-editor>` de la aplicación. */
export interface MapEditorConfig {
  /** URL del worker de MapLibre (p. ej. copiado a /assets con la configuración de `angular.json`). */
  workerUrl?: string;
  /** URL de `sql-wasm.wasm` (GeoPackage). */
  sqlWasmUrl?: string;
  /** Carpeta de GDAL-WASM (formatos adicionales). */
  gdalPath?: string;
  /** URL de teselas OSM para producción. */
  osmTileUrl?: string;
  basemap?: string;
  basemaps?: BasemapDef[];
  snapping?: Partial<SnapConfig>;
}

export const MAP_EDITOR_CONFIG = new InjectionToken<MapEditorConfig>('MAP_EDITOR_CONFIG', {
  providedIn: 'root',
  factory: () => ({}),
});

/**
 * Configuración global del editor:
 *
 * ```ts
 * bootstrapApplication(App, { providers: [provideMapEditor({ workerUrl: '/assets/maplibre/maplibre-gl-worker.mjs' })] });
 * ```
 */
export function provideMapEditor(config: MapEditorConfig): EnvironmentProviders {
  return makeEnvironmentProviders([{ provide: MAP_EDITOR_CONFIG, useValue: config }]);
}
