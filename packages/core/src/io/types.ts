import type { Geometry } from 'geojson';
import type { EditorFeature, ExportFormat, FieldDef, LayerInfo, LayerSource } from '../types.js';

export interface InputFile {
  name: string;
  data: ArrayBuffer | Uint8Array;
}

export interface ImportedFeature {
  geometry: Geometry | null;
  properties: Record<string, unknown>;
  id?: string | number;
}

/** Capa leída de un fichero, ya en WGS84. */
export interface ImportedLayer {
  name: string;
  features: ImportedFeature[];
  source: LayerSource;
  fields?: FieldDef[];
  warnings: string[];
}

export type ExportScope = 'all' | 'changes';

export interface ExportOptions {
  /** Formato de salida. Por defecto, el formato de origen de la capa (GeoJSON si se creó en el editor). */
  format?: ExportFormat;
  /** CRS de salida. Por defecto, el CRS original de la capa. */
  crs?: string;
  /**
   * `all`: estado actual completo (sin las borradas).
   * `changes`: solo nuevas, modificadas y borradas, con un atributo `_cambio`.
   */
  scope?: ExportScope;
  /** Nombre base del fichero (sin extensión). */
  fileName?: string;
}

export interface ExportResult {
  fileName: string;
  data: Uint8Array;
  mimeType: string;
  warnings: string[];
}

/** Datos que recibe cada escritor: entidades ya transformadas al CRS de salida. */
export interface WriterInput {
  layer: LayerInfo;
  features: EditorFeature[];
  fields: FieldDef[];
  crs: string;
  hasZ: boolean;
  baseName: string;
}

export interface IoConfig {
  /** URL del `sql-wasm.wasm` de sql.js (GeoPackage). Por defecto, jsDelivr. */
  sqlWasmUrl?: string;
  /** Configuración de GDAL-WASM (formatos adicionales). */
  gdal?: {
    enabled?: boolean;
    /** Carpeta donde están `gdal3WebAssembly.wasm` y `gdal3WebAssembly.data`. */
    path?: string;
  };
}

export class UnsupportedFormatError extends Error {
  constructor(public fileName: string) {
    super(`Formato no soportado: ${fileName}`);
  }
}

export const toBytes = (d: ArrayBuffer | Uint8Array): Uint8Array => (d instanceof Uint8Array ? d : new Uint8Array(d));

export const baseName = (name: string) => name.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
export const extension = (name: string) => (name.match(/\.([^.\\/]+)$/)?.[1] ?? '').toLowerCase();
