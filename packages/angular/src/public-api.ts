/*
 * API pública de @map-editor/angular
 */
export { MapEditorComponent } from './lib/map-editor.component';
export { MAP_EDITOR_CONFIG, provideMapEditor, type MapEditorConfig } from './lib/config';
export type {
  MapEditor,
  MapEditorElement,
  LayerInfo,
  FeatureRef,
  EditorFeature,
  SnapConfig,
  ExportOptions,
  BasemapDef,
} from '@map-editor/web-component';
