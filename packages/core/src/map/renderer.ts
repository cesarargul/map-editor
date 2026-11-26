import type { Feature, FeatureCollection, Geometry } from 'geojson';
import type { ExpressionSpecification, GeoJSONSource, Map as MlMap } from 'maplibre-gl';
import type { FeatureStore } from '../store/store.js';
import type { EditorFeature, LayerInfo } from '../types.js';

export const OVERLAY_SOURCE = 'me-overlay';
export const FID = '__fid';
export const STATUS = '__status';

const OVERLAY_LAYERS = ['me-overlay-fill', 'me-overlay-line', 'me-overlay-midpoint', 'me-overlay-vertex', 'me-overlay-snap'] as const;

export const SELECTED_COLOR = '#ffb400';
const STATUS_COLOR: ExpressionSpecification = ['match', ['get', STATUS], 'new', '#2ecc71', 'modified', '#ff7f0e', 'transparent'];

export const sourceId = (layerId: string) => `me-src-${layerId}`;
export const renderLayerIds = (layerId: string) => ({
  fill: `me-${layerId}-fill`,
  changes: `me-${layerId}-changes`,
  line: `me-${layerId}-line`,
  point: `me-${layerId}-point`,
});

const POLY: ExpressionSpecification = ['in', ['geometry-type'], ['literal', ['Polygon', 'MultiPolygon']]];
const LINEISH: ExpressionSpecification = ['in', ['geometry-type'], ['literal', ['LineString', 'MultiLineString', 'Polygon', 'MultiPolygon']]];
const POINT: ExpressionSpecification = ['in', ['geometry-type'], ['literal', ['Point', 'MultiPoint']]];

export function toRenderFeature(f: Readonly<EditorFeature>): Feature {
  return {
    type: 'Feature',
    geometry: f.geometry as Geometry,
    properties: { ...f.properties, [FID]: f.id, [STATUS]: f.status },
  };
}

/** Sincroniza el almacén con fuentes y capas de MapLibre. */
export class Renderer {
  constructor(
    private readonly map: MlMap,
    private readonly store: FeatureStore,
    /** Pantalla táctil: asas más grandes. */
    private readonly coarse = false,
  ) {}

  /** Crea fuentes/capas que falten (tras cargar un estilo nuevo). */
  ensureAll(): void {
    this.ensureOverlay();
    for (const layer of this.store.getLayers()) this.ensureLayer(layer);
  }

  ensureOverlay(): void {
    const map = this.map;
    if (!map.getSource(OVERLAY_SOURCE)) {
      map.addSource(OVERLAY_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    }
    const add = (spec: Parameters<MlMap['addLayer']>[0]) => {
      if (!map.getLayer(spec.id)) map.addLayer(spec);
    };
    const kind = (k: string | string[]): ExpressionSpecification =>
      Array.isArray(k) ? ['in', ['get', 'kind'], ['literal', k]] : ['==', ['get', 'kind'], k];
    add({ id: 'me-overlay-fill', type: 'fill', source: OVERLAY_SOURCE, filter: kind('sketch-fill'), paint: { 'fill-color': SELECTED_COLOR, 'fill-opacity': 0.15 } });
    add({
      id: 'me-overlay-line',
      type: 'line',
      source: OVERLAY_SOURCE,
      filter: kind(['sketch-line', 'box']),
      paint: { 'line-color': SELECTED_COLOR, 'line-width': 2, 'line-dasharray': [2, 1.5] },
    });
    add({
      id: 'me-overlay-midpoint',
      type: 'circle',
      source: OVERLAY_SOURCE,
      filter: kind('midpoint'),
      paint: { 'circle-radius': this.coarse ? 6 : 3.5, 'circle-color': '#ffffff', 'circle-opacity': 0.85, 'circle-stroke-color': SELECTED_COLOR, 'circle-stroke-width': 1.5 },
    });
    add({
      id: 'me-overlay-vertex',
      type: 'circle',
      source: OVERLAY_SOURCE,
      filter: kind(['vertex', 'sketch-vertex']),
      paint: {
        'circle-radius': ['case', ['boolean', ['get', 'active'], false], this.coarse ? 11 : 7, this.coarse ? 8 : 5],
        'circle-color': ['case', ['boolean', ['get', 'active'], false], SELECTED_COLOR, '#ffffff'],
        'circle-stroke-color': ['case', ['boolean', ['get', 'endpoint'], false], '#c0392b', '#333333'],
        'circle-stroke-width': 2,
      },
    });
    add({
      id: 'me-overlay-snap',
      type: 'circle',
      source: OVERLAY_SOURCE,
      filter: kind('snap'),
      paint: {
        'circle-radius': 8,
        'circle-color': 'transparent',
        'circle-stroke-width': 3,
        'circle-stroke-color': [
          'case',
          ['boolean', ['get', 'zConflict'], false],
          '#e74c3c',
          ['match', ['get', 'snapType'], 'vertex', '#e91e63', 'endpoint', '#e91e63', 'intersection', '#9b59b6', 'midpoint', '#00bcd4', '#2196f3'],
        ],
      },
    });
  }

  ensureLayer(layer: LayerInfo): void {
    const map = this.map;
    const src = sourceId(layer.id);
    if (!map.getSource(src)) {
      map.addSource(src, { type: 'geojson', data: this.collection(layer.id), promoteId: FID });
    }
    const ids = renderLayerIds(layer.id);
    const before = this.firstOverlayLayer();
    const vis = layer.visible ? 'visible' : 'none';
    const selected: ExpressionSpecification = ['boolean', ['feature-state', 'selected'], false];
    const hover: ExpressionSpecification = ['boolean', ['feature-state', 'hover'], false];
    if (!map.getLayer(ids.fill)) {
      map.addLayer(
        {
          id: ids.fill,
          type: 'fill',
          source: src,
          filter: POLY,
          layout: { visibility: vis },
          paint: { 'fill-color': ['case', selected, SELECTED_COLOR, layer.style.color], 'fill-opacity': layer.style.fillOpacity },
        },
        before,
      );
    }
    if (!map.getLayer(ids.changes)) {
      map.addLayer(
        {
          id: ids.changes,
          type: 'line',
          source: src,
          filter: ['all', LINEISH, ['!=', ['get', STATUS], 'original']],
          layout: { visibility: vis, 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': STATUS_COLOR, 'line-width': layer.style.lineWidth + 6, 'line-opacity': 0.45 },
        },
        before,
      );
    }
    if (!map.getLayer(ids.line)) {
      map.addLayer(
        {
          id: ids.line,
          type: 'line',
          source: src,
          filter: LINEISH,
          layout: { visibility: vis, 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': ['case', selected, SELECTED_COLOR, layer.style.color],
            'line-width': ['case', selected, layer.style.lineWidth + 2, hover, layer.style.lineWidth + 1.5, layer.style.lineWidth],
          },
        },
        before,
      );
    }
    if (!map.getLayer(ids.point)) {
      map.addLayer(
        {
          id: ids.point,
          type: 'circle',
          source: src,
          filter: POINT,
          layout: { visibility: vis },
          paint: {
            'circle-radius': ['case', selected, layer.style.pointRadius + 2, hover, layer.style.pointRadius + 1, layer.style.pointRadius],
            'circle-color': ['case', selected, SELECTED_COLOR, layer.style.color],
            'circle-stroke-color': ['match', ['get', STATUS], 'new', '#2ecc71', 'modified', '#ff7f0e', '#ffffff'],
            'circle-stroke-width': ['match', ['get', STATUS], 'original', 1.5, 3],
          },
        },
        before,
      );
    }
  }

  removeLayer(layerId: string): void {
    for (const id of Object.values(renderLayerIds(layerId))) if (this.map.getLayer(id)) this.map.removeLayer(id);
    if (this.map.getSource(sourceId(layerId))) this.map.removeSource(sourceId(layerId));
  }

  applyStyle(layer: LayerInfo): void {
    const map = this.map;
    const ids = renderLayerIds(layer.id);
    if (!map.getLayer(ids.line)) return this.ensureLayer(layer);
    const vis = layer.visible ? 'visible' : 'none';
    for (const id of Object.values(ids)) map.setLayoutProperty(id, 'visibility', vis);
    const selected: ExpressionSpecification = ['boolean', ['feature-state', 'selected'], false];
    const hover: ExpressionSpecification = ['boolean', ['feature-state', 'hover'], false];
    map.setPaintProperty(ids.fill, 'fill-color', ['case', selected, SELECTED_COLOR, layer.style.color]);
    map.setPaintProperty(ids.fill, 'fill-opacity', layer.style.fillOpacity);
    map.setPaintProperty(ids.line, 'line-color', ['case', selected, SELECTED_COLOR, layer.style.color]);
    map.setPaintProperty(ids.line, 'line-width', ['case', selected, layer.style.lineWidth + 2, hover, layer.style.lineWidth + 1.5, layer.style.lineWidth]);
    map.setPaintProperty(ids.changes, 'line-width', layer.style.lineWidth + 6);
    map.setPaintProperty(ids.point, 'circle-color', ['case', selected, SELECTED_COLOR, layer.style.color]);
    map.setPaintProperty(ids.point, 'circle-radius', ['case', selected, layer.style.pointRadius + 2, hover, layer.style.pointRadius + 1, layer.style.pointRadius]);
  }

  /** Reordena las capas de MapLibre según el orden del almacén (la primera, abajo). */
  applyOrder(): void {
    const before = this.firstOverlayLayer();
    for (const layer of this.store.getLayers()) {
      for (const id of Object.values(renderLayerIds(layer.id))) {
        if (this.map.getLayer(id)) this.map.moveLayer(id, before);
      }
    }
  }

  /** Actualiza solo las entidades cambiadas (diff); si falla, recarga la fuente completa. */
  updateFeatures(layerId: string, featureIds: string[]): void {
    const src = this.map.getSource(sourceId(layerId)) as GeoJSONSource | undefined;
    if (!src) return;
    if (featureIds.length === 0 || featureIds.length > 500) {
      void src.setData(this.collection(layerId));
      return;
    }
    const remove: string[] = [];
    const add: Feature[] = [];
    for (const id of featureIds) {
      const f = this.store.getFeature(layerId, id);
      if (!f || f.status === 'deleted' || !f.geometry) remove.push(id);
      else add.push(toRenderFeature(f));
    }
    src.updateData({ remove, add }).catch(() => void src.setData(this.collection(layerId)));
  }

  reload(layerId: string): void {
    const src = this.map.getSource(sourceId(layerId)) as GeoJSONSource | undefined;
    void src?.setData(this.collection(layerId));
  }

  setOverlay(features: Feature[]): void {
    const src = this.map.getSource(OVERLAY_SOURCE) as GeoJSONSource | undefined;
    void src?.setData({ type: 'FeatureCollection', features });
  }

  queryLayerIds(layerIds: string[]): string[] {
    return layerIds.flatMap((id) => {
      const r = renderLayerIds(id);
      return [r.point, r.line, r.fill].filter((l) => this.map.getLayer(l));
    });
  }

  private collection(layerId: string): FeatureCollection {
    return {
      type: 'FeatureCollection',
      features: this.store.getFeatures(layerId).filter((f) => f.geometry).map(toRenderFeature),
    };
  }

  private firstOverlayLayer(): string | undefined {
    return OVERLAY_LAYERS.find((id) => this.map.getLayer(id));
  }
}
