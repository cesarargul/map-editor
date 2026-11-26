import type { FeatureCollection, Geometry, Position } from 'geojson';
import { gpx as gpxToGeoJSON, kml as kmlToGeoJSON } from '@tmcw/togeojson';
import type { ImportedFeature, WriterInput } from './types.js';

type DomParserCtor = new () => { parseFromString(text: string, type: string): unknown };
let ParserCtor: DomParserCtor | null = null;

/** Permite inyectar un DOMParser fuera del navegador (p. ej. `@xmldom/xmldom` en Node). */
export function setXmlParser(ctor: DomParserCtor): void {
  ParserCtor = ctor;
}

function parseXml(text: string): Document {
  const Ctor = ParserCtor ?? (globalThis as { DOMParser?: DomParserCtor }).DOMParser;
  if (!Ctor) throw new Error('No hay DOMParser disponible: usa setXmlParser() fuera del navegador.');
  return new Ctor().parseFromString(text, 'text/xml') as Document;
}

function toImported(fc: FeatureCollection): ImportedFeature[] {
  return fc.features.map((f) => ({
    geometry: (f.geometry as Geometry | null) ?? null,
    properties: { ...(f.properties ?? {}) },
    ...(f.id !== undefined ? { id: f.id } : {}),
  }));
}

export function readKml(text: string): ImportedFeature[] {
  return toImported(kmlToGeoJSON(parseXml(text)) as FeatureCollection);
}

export function readGpx(text: string): ImportedFeature[] {
  return toImported(gpxToGeoJSON(parseXml(text)) as FeatureCollection);
}

const esc = (s: unknown) =>
  String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);

const NAME_KEYS = ['name', 'nombre', 'Name', 'NOMBRE', 'title', 'titulo'];
const nameOf = (p: Record<string, unknown>) => NAME_KEYS.map((k) => p[k]).find((v) => v != null && v !== '');

const fmt = (c: Position, z: boolean) => (z ? `${c[0]},${c[1]},${c[2] ?? 0}` : `${c[0]},${c[1]}`);

function kmlGeometry(g: Geometry, z: boolean): string {
  const alt = z ? '<altitudeMode>absolute</altitudeMode>' : '';
  const ring = (r: Position[]) => `<LinearRing><coordinates>${r.map((c) => fmt(c, z)).join(' ')}</coordinates></LinearRing>`;
  switch (g.type) {
    case 'Point':
      return `<Point>${alt}<coordinates>${fmt(g.coordinates, z)}</coordinates></Point>`;
    case 'LineString':
      return `<LineString>${alt}<coordinates>${g.coordinates.map((c) => fmt(c, z)).join(' ')}</coordinates></LineString>`;
    case 'Polygon':
      return `<Polygon>${alt}<outerBoundaryIs>${ring(g.coordinates[0] ?? [])}</outerBoundaryIs>${g.coordinates
        .slice(1)
        .map((r) => `<innerBoundaryIs>${ring(r)}</innerBoundaryIs>`)
        .join('')}</Polygon>`;
    case 'MultiPoint':
      return `<MultiGeometry>${g.coordinates.map((c) => kmlGeometry({ type: 'Point', coordinates: c }, z)).join('')}</MultiGeometry>`;
    case 'MultiLineString':
      return `<MultiGeometry>${g.coordinates.map((c) => kmlGeometry({ type: 'LineString', coordinates: c }, z)).join('')}</MultiGeometry>`;
    case 'MultiPolygon':
      return `<MultiGeometry>${g.coordinates.map((c) => kmlGeometry({ type: 'Polygon', coordinates: c }, z)).join('')}</MultiGeometry>`;
    case 'GeometryCollection':
      return `<MultiGeometry>${g.geometries.map((c) => kmlGeometry(c, z)).join('')}</MultiGeometry>`;
  }
}

/** KML 2.2 (siempre en WGS84). Los atributos van en ExtendedData. */
export function writeKml(input: WriterInput, extra?: { name: string; values: string[] }): string {
  const skip = new Set(['styleUrl', 'styleHash', 'styleMapHash', 'stroke', 'stroke-opacity', 'stroke-width', 'fill', 'fill-opacity']);
  const placemarks = input.features.map((f, i) => {
    const props = extra ? { ...f.properties, [extra.name]: extra.values[i] } : f.properties;
    const name = nameOf(props);
    const data = Object.entries(props)
      .filter(([k, v]) => !skip.has(k) && v !== null && v !== undefined && typeof v !== 'object')
      .map(([k, v]) => `<Data name="${esc(k)}"><value>${esc(v)}</value></Data>`)
      .join('');
    return `<Placemark>${name !== undefined ? `<name>${esc(name)}</name>` : ''}${data ? `<ExtendedData>${data}</ExtendedData>` : ''}${
      f.geometry ? kmlGeometry(f.geometry, input.hasZ) : ''
    }</Placemark>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${esc(input.layer.name)}</name>\n${placemarks.join('\n')}\n</Document></kml>\n`;
}

/** GPX 1.1: puntos → wpt, líneas → trk. Los polígonos no existen en GPX. */
export function writeGpx(input: WriterInput, warnings: string[]): string {
  const wpts: string[] = [];
  const trks: string[] = [];
  let skipped = 0;
  const pt = (tag: string, c: Position, inner = '') =>
    `<${tag} lat="${c[1]}" lon="${c[0]}">${input.hasZ && c[2] !== undefined ? `<ele>${c[2]}</ele>` : ''}${inner}</${tag}>`;
  for (const f of input.features) {
    const name = nameOf(f.properties);
    const meta = `${name !== undefined ? `<name>${esc(name)}</name>` : ''}${f.properties['desc'] ? `<desc>${esc(f.properties['desc'])}</desc>` : ''}`;
    const g = f.geometry;
    if (!g) continue;
    if (g.type === 'Point') wpts.push(pt('wpt', g.coordinates, meta));
    else if (g.type === 'MultiPoint') g.coordinates.forEach((c) => wpts.push(pt('wpt', c, meta)));
    else if (g.type === 'LineString' || g.type === 'MultiLineString') {
      const lines = g.type === 'LineString' ? [g.coordinates] : g.coordinates;
      trks.push(`<trk>${meta}${lines.map((l) => `<trkseg>${l.map((c) => pt('trkpt', c)).join('')}</trkseg>`).join('')}</trk>`);
    } else skipped++;
  }
  if (skipped) warnings.push(`GPX no admite polígonos: se han omitido ${skipped} entidades.`);
  warnings.push('GPX solo conserva nombre, descripción y elevación; el resto de atributos se pierde.');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="map-editor" xmlns="http://www.topografix.com/GPX/1/1">\n${wpts.join('\n')}\n${trks.join('\n')}\n</gpx>\n`;
}
