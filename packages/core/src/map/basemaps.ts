import type { StyleSpecification } from 'maplibre-gl';

export interface RasterBasemapLayer {
  tiles: string[];
  tileSize?: number;
  maxzoom?: number;
  minzoom?: number;
  attribution?: string;
}

export interface BasemapDef {
  id: string;
  name: string;
  group: string;
  /** `raster`: una o varias capas de teselas; `style`: estilo MapLibre completo (vectorial). */
  type: 'raster' | 'style';
  layers?: RasterBasemapLayer[];
  style?: string | StyleSpecification;
  /** Miniatura opcional para el selector. */
  thumbnail?: string;
}

const IGN_ATTR = '© <a href="https://www.ign.es" target="_blank" rel="noopener">Instituto Geográfico Nacional</a> (CC BY 4.0)';
const OSM_ATTR = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';

/** Plantilla WMTS KVP del IGN en GoogleMapsCompatible (EPSG:3857). */
export function ignWmts(service: string, layer: string, format = 'image/png'): string {
  return (
    `https://www.ign.es/wmts/${service}?service=WMTS&request=GetTile&version=1.0.0` +
    `&Format=${encodeURIComponent(format)}&layer=${layer}&style=default` +
    `&tilematrixset=GoogleMapsCompatible&TileMatrix={z}&TileRow={y}&TileCol={x}`
  );
}

/**
 * Mapas base por defecto. OSM estándar es el predeterminado; su URL se puede cambiar
 * (la política de uso de tile.openstreetmap.org no permite uso intensivo en producción).
 */
export function defaultBasemaps(opts: { osmTileUrl?: string } = {}): BasemapDef[] {
  return [
    {
      id: 'osm',
      name: 'OpenStreetMap',
      group: 'OpenStreetMap',
      type: 'raster',
      layers: [{ tiles: [opts.osmTileUrl ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'], maxzoom: 19, attribution: OSM_ATTR }],
    },
    {
      id: 'openfreemap',
      name: 'OpenFreeMap (vectorial)',
      group: 'OpenStreetMap',
      type: 'style',
      style: 'https://tiles.openfreemap.org/styles/liberty',
    },
    {
      id: 'ign-base',
      name: 'IGN Base',
      group: 'IGN',
      type: 'raster',
      layers: [{ tiles: [ignWmts('ign-base', 'IGNBaseTodo')], maxzoom: 20, attribution: IGN_ATTR }],
    },
    {
      id: 'ign-pnoa',
      name: 'PNOA Máxima Actualidad',
      group: 'IGN',
      type: 'raster',
      layers: [{ tiles: [ignWmts('pnoa-ma', 'OI.OrthoimageCoverage', 'image/jpeg')], maxzoom: 20, attribution: `${IGN_ATTR} · PNOA` }],
    },
    {
      id: 'ign-pnoa-hibrido',
      name: 'PNOA + rótulos IGN',
      group: 'IGN',
      type: 'raster',
      layers: [
        { tiles: [ignWmts('pnoa-ma', 'OI.OrthoimageCoverage', 'image/jpeg')], maxzoom: 20, attribution: `${IGN_ATTR} · PNOA` },
        { tiles: [ignWmts('ign-base', 'IGNBaseOrto')], maxzoom: 20 },
      ],
    },
    {
      id: 'ign-mtn',
      name: 'Mapa Topográfico (MTN)',
      group: 'IGN',
      type: 'raster',
      layers: [{ tiles: [ignWmts('mapa-raster', 'MTN', 'image/jpeg')], maxzoom: 20, attribution: IGN_ATTR }],
    },
    {
      id: 'ign-vector',
      name: 'Mapa Base IGN (vectorial)',
      group: 'IGN',
      type: 'style',
      style: 'https://vt-mapabase.idee.es/files/styles/mapaBase_scn_color1_CNIG.json',
    },
    {
      id: 'none',
      name: 'Sin fondo',
      group: 'Otros',
      type: 'raster',
      layers: [],
    },
  ];
}

export const BASEMAP_PREFIX = 'basemap-';

/** Estilo mínimo para un mapa base raster. */
export function rasterStyle(def: BasemapDef): StyleSpecification {
  const style: StyleSpecification = {
    version: 8,
    sources: {},
    layers: [{ id: `${BASEMAP_PREFIX}background`, type: 'background', paint: { 'background-color': '#f2efe9' } }],
  };
  (def.layers ?? []).forEach((l, i) => {
    const id = `${BASEMAP_PREFIX}${i}`;
    style.sources[id] = {
      type: 'raster',
      tiles: l.tiles,
      tileSize: l.tileSize ?? 256,
      ...(l.maxzoom !== undefined ? { maxzoom: l.maxzoom } : {}),
      ...(l.minzoom !== undefined ? { minzoom: l.minzoom } : {}),
      ...(l.attribution ? { attribution: l.attribution } : {}),
    };
    style.layers.push({ id, type: 'raster', source: id });
  });
  return style;
}
