import type { Feature, Geometry, Position } from 'geojson';
import type { Map as MlMap } from 'maplibre-gl';
import type { VertexPath } from '../geom/coords.js';
import type { SnapResult } from '../snapping/snapper.js';
import type { FeatureStore } from '../store/store.js';
import type { FeatureRef, GeometryKind, Projector, ScreenPoint } from '../types.js';

export type ToolId = 'select' | 'draw-point' | 'draw-line' | 'draw-polygon' | 'move';

export interface ToolPointerEvent {
  point: ScreenPoint;
  /** Posición bajo el cursor (sin snap). */
  lngLat: Position;
  /** Posición final: la del snap si lo hay, si no `lngLat`. */
  coord: Position;
  snap: SnapResult | null;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  /** Llamar para que el mapa no haga pan/zoom con este gesto. */
  preventDefault(): void;
}

export interface SnapRequest {
  excludeVertices?: Array<FeatureRef & { path: VertexPath }>;
  excludeFeatures?: FeatureRef[];
  /** Capa que se edita (para la matriz de snapping). */
  editingLayerId?: string | null;
}

/** API que el editor ofrece a las herramientas. */
export interface ToolContext {
  readonly map: MlMap;
  readonly store: FeatureStore;
  readonly projector: Projector;
  activeLayerId(): string | null;
  getSelection(): FeatureRef[];
  setSelection(refs: FeatureRef[]): void;
  /** Entidades bajo un punto o rectángulo de pantalla, de arriba abajo. */
  hitTest(point: ScreenPoint, tolerancePx?: number): FeatureRef[];
  hitTestBox(a: ScreenPoint, b: ScreenPoint): FeatureRef[];
  /** Asas (vértices/puntos medios) bajo el cursor. */
  hitHandle(point: ScreenPoint): { kind: 'vertex' | 'midpoint'; path: VertexPath } | null;
  isEditable(layerId: string): boolean;
  /** Capa donde dibujar una geometría del tipo indicado (la activa si es compatible o una nueva). */
  drawTarget(kind: Exclude<GeometryKind, 'Mixed'>): string | null;
  /** Completa la Z de las coordenadas nuevas en capas 3D. */
  withZ(coord: Position, layerId: string): Position;
  /** Muestra una geometría provisional sin tocar el almacén (arrastres). */
  preview(layerId: string, featureId: string, geometry: Geometry | null): void;
  /** Descarta las vistas provisionales de una capa. */
  refresh(layerId: string): void;
  redraw(): void;
  deleteSelected(): void;
  setTool(id: ToolId): void;
  message(level: 'info' | 'warning' | 'error', text: string): void;
}

export interface Tool {
  readonly id: ToolId;
  activate(ctx: ToolContext): void;
  deactivate(): void;
  /** Opciones de snapping para el estado actual, o `null` si no se debe hacer snap. */
  snapRequest(): SnapRequest | null;
  onPointerDown?(e: ToolPointerEvent): void;
  onPointerMove?(e: ToolPointerEvent): void;
  onPointerUp?(e: ToolPointerEvent): void;
  onClick?(e: ToolPointerEvent): void;
  onDoubleClick?(e: ToolPointerEvent): void;
  /** Devuelve `true` si ha consumido la tecla. */
  onKeyDown?(e: KeyboardEvent): boolean;
  overlay(): Feature[];
  cursor(): string;
}

export const pt = (coordinates: Position, properties: Record<string, unknown>): Feature => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates },
  properties,
});
