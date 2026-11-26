export { MapEditor, setMapLibreWorkerUrl, type MapEditorOptions, type EditorEvents, type MessageLevel } from './editor.js';
export * from './types.js';
export { FeatureStore, inferFields, type HistoryEntry, type StoreEvents, type NewLayerInput, Transaction } from './store/store.js';
export { Snapper, type SnapResult, type SnapQuery, lerpCoord } from './snapping/snapper.js';
export { DEFAULT_SNAP_CONFIG, ALL_SNAP_TYPES, normalizeSnapConfig, resolveTargets, type SnapConfig, type SnapType, type SnapTargetOptions } from './snapping/config.js';
export * from './geom/coords.js';
export { KNOWN_CRS, registerCrs, resolveCrs, normalizeCrsCode, transformGeometry, guessCrs, wktForCrs } from './crs/crs.js';
export {
  readFiles,
  writeLayer,
  readGeoJsonObject,
  memorySource,
  setXmlParser,
  configureSqlJs,
  SUPPORTED_EXTENSIONS,
  EXPORT_FORMATS,
  type ReadResult,
  type InputFile,
  type ImportedLayer,
  type ImportedFeature,
  type ExportOptions,
  type ExportResult,
  type ExportScope,
  type IoConfig,
} from './io/index.js';
export { defaultBasemaps, rasterStyle, ignWmts, type BasemapDef, type RasterBasemapLayer } from './map/basemaps.js';
export { IndexedDbSessionStorage, MemorySessionStorage, type SessionStorage, type SavedSession, type SessionSummary, type AutosaveOptions } from './persistence/autosave.js';
export { installDropZone, downloadBlob, filesFromDataTransfer, type DropZoneOptions } from './util/dropzone.js';
export { Emitter } from './util/emitter.js';
export type { ToolId, Tool, ToolContext, ToolPointerEvent } from './tools/tool.js';
