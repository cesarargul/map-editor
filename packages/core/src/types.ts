import type { Geometry, Position } from 'geojson';

export type { Geometry, Position };

/** Estado de una entidad respecto al fichero original. */
export type FeatureStatus = 'original' | 'new' | 'modified' | 'deleted';

/** Tipo de geometría dominante de una capa. */
export type GeometryKind = 'Point' | 'LineString' | 'Polygon' | 'Mixed';

/** Formatos de origen soportados. `gdal` agrupa los formatos leídos con GDAL-WASM. */
export type SourceFormat = 'geojson' | 'shapefile' | 'kml' | 'gpx' | 'gpkg' | 'flatgeobuf' | 'gdal' | 'memory';

/** Formatos de exportación. */
export type ExportFormat = Exclude<SourceFormat, 'memory'>;

export type FieldType = 'string' | 'number' | 'integer' | 'boolean' | 'date';

export interface FieldDef {
  name: string;
  type: FieldType;
}

/**
 * Entidad tal y como la guarda el editor. Las coordenadas están siempre en WGS84 (lon, lat[, z]);
 * el CRS original se conserva en la capa y se usa al exportar.
 */
export interface EditorFeature {
  /** Identificador interno estable. */
  id: string;
  geometry: Geometry | null;
  properties: Record<string, unknown>;
  status: FeatureStatus;
  /** Identificador en el fichero de origen (fid de GeoPackage, id de GeoJSON…), si existía. */
  sourceId?: string | number;
}

/** Metadatos del fichero de origen, necesarios para devolver la capa en el mismo formato y CRS. */
export interface LayerSource {
  format: SourceFormat;
  fileName?: string;
  /** Código del CRS original, p. ej. `EPSG:25830`. */
  crs: string;
  /** WKT original (p. ej. del `.prj`), si se conocía. */
  crsWkt?: string;
  /** Verdadero si el CRS se ha deducido por heurística y no venía declarado. */
  crsGuessed?: boolean;
  /** Las geometrías tienen coordenada Z. */
  hasZ: boolean;
  /** Codificación de texto original (Shapefile). */
  encoding?: string;
  /** Opciones propias del formato (nombre de tabla GPKG, driver GDAL…). */
  formatOptions?: Record<string, unknown>;
}

export interface LayerStyle {
  color: string;
  /** Opacidad del relleno de polígonos (0-1). */
  fillOpacity: number;
  lineWidth: number;
  pointRadius: number;
}

export interface LayerInfo {
  id: string;
  name: string;
  geometryKind: GeometryKind;
  source: LayerSource;
  fields: FieldDef[];
  style: LayerStyle;
  visible: boolean;
  editable: boolean;
  /** Z que se asigna a los vértices nuevos sin Z en capas 3D. */
  defaultZ: number;
}

export interface FeatureRef {
  layerId: string;
  featureId: string;
}

/** Resumen de cambios de una capa. */
export interface ChangeSummary {
  new: number;
  modified: number;
  deleted: number;
}

export interface ScreenPoint {
  x: number;
  y: number;
}

/** Conversión entre coordenadas geográficas y píxeles de pantalla. */
export interface Projector {
  project(coord: Position): ScreenPoint;
  unproject(point: ScreenPoint): Position;
}
