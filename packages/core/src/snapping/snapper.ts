import type { Position } from 'geojson';
import RBush from 'rbush';
import { fromMercator, getSegments, getVertices, toMercator, type VertexPath } from '../geom/coords.js';
import type { EditorFeature, FeatureRef, Projector, ScreenPoint } from '../types.js';
import { resolveTargets, targetTypes, type SnapConfig, type SnapType } from './config.js';

interface BaseItem {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  layerId: string;
  featureId: string;
}

interface VertexItem extends BaseItem {
  kind: 'vertex';
  coord: Position;
  path: VertexPath;
  isEndpoint: boolean;
}

interface SegmentItem extends BaseItem {
  kind: 'segment';
  a: Position;
  b: Position;
  pathA: VertexPath;
  pathB: VertexPath;
}

type Item = VertexItem | SegmentItem;

export interface SnapResult {
  coord: Position;
  type: SnapType;
  layerId: string;
  featureId: string;
  /** Ruta del vértice destino (snap a vértice/extremo). */
  path?: VertexPath;
  distancePx: number;
  /** Las dos geometrías se cruzan en XY pero sus Z difieren más que `zTolerance` (no conectadas en 3D). */
  zConflict?: boolean;
  /** Z de cada elemento implicado en una intersección. */
  zValues?: Array<number | undefined>;
  /** Segundo elemento implicado (intersección). */
  other?: FeatureRef;
}

export interface SnapQuery {
  point: ScreenPoint;
  projector: Projector;
  /** Capa que se está editando (determina las capas destino según la matriz). */
  editingLayerId: string | null;
  /** Capas candidatas (normalmente las visibles). */
  availableLayerIds: string[];
  /** Vértices a ignorar (el que se arrastra) y los segmentos que lo tocan. */
  excludeVertices?: Array<FeatureRef & { path: VertexPath }>;
  /** Entidades completas a ignorar (las que se están moviendo). */
  excludeFeatures?: FeatureRef[];
}

const TYPE_PENALTY: Record<SnapType, number> = {
  endpoint: 0,
  vertex: 0,
  intersection: 0.5,
  midpoint: 1.5,
  edge: 3,
};

const samePath = (a: VertexPath, b: VertexPath) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Índice espacial (R-tree) de vértices y segmentos por capa, con actualización incremental
 * por entidad, y motor de snapping en píxeles de pantalla.
 */
export class Snapper {
  private trees = new Map<string, RBush<Item>>();
  private byFeature = new Map<string, Map<string, Item[]>>();

  constructor(public config: SnapConfig) {}

  /** Reconstruye el índice de una capa. */
  indexLayer(layerId: string, features: Iterable<Readonly<EditorFeature>>): void {
    const tree = new RBush<Item>();
    const map = new Map<string, Item[]>();
    const all: Item[] = [];
    for (const f of features) {
      if (f.status === 'deleted') continue;
      const items = this.itemsFor(layerId, f);
      map.set(f.id, items);
      all.push(...items);
    }
    tree.load(all);
    this.trees.set(layerId, tree);
    this.byFeature.set(layerId, map);
  }

  /** Actualiza las entidades indicadas (`null` = eliminada). */
  updateFeatures(layerId: string, changes: Array<{ id: string; feature: Readonly<EditorFeature> | null }>): void {
    let tree = this.trees.get(layerId);
    let map = this.byFeature.get(layerId);
    if (!tree || !map) {
      tree = new RBush<Item>();
      map = new Map();
      this.trees.set(layerId, tree);
      this.byFeature.set(layerId, map);
    }
    for (const { id, feature } of changes) {
      for (const it of map.get(id) ?? []) tree.remove(it);
      map.delete(id);
      if (feature && feature.status !== 'deleted') {
        const items = this.itemsFor(layerId, feature);
        map.set(id, items);
        for (const it of items) tree.insert(it);
      }
    }
  }

  removeLayer(layerId: string): void {
    this.trees.delete(layerId);
    this.byFeature.delete(layerId);
  }

  /** Busca el mejor punto de snap cerca de `query.point`. */
  snap(query: SnapQuery): SnapResult | null {
    const cfg = this.config;
    if (!cfg.enabled) return null;
    const targets = resolveTargets(cfg, query.editingLayerId, query.availableLayerIds);
    if (targets.length === 0) return null;

    const { projector, point } = query;
    const maxTol = Math.max(cfg.tolerancePx, ...targets.map((t) => cfg.targets[t]?.tolerancePx ?? 0));
    const box = screenBoxToLngLat(projector, point, maxTol);

    const excludedFeature = (it: Item) =>
      query.excludeFeatures?.some((r) => r.layerId === it.layerId && r.featureId === it.featureId) ?? false;
    const excludedVertex = (layerId: string, featureId: string, path: VertexPath) =>
      query.excludeVertices?.some((r) => r.layerId === layerId && r.featureId === featureId && samePath(r.path, path)) ??
      false;

    const candidates: SnapResult[] = [];
    const segsForIntersection: Array<{ it: SegmentItem; sa: ScreenPoint; sb: ScreenPoint; types: SnapType[] }> = [];

    for (const layerId of targets) {
      const tree = this.trees.get(layerId);
      if (!tree) continue;
      const types = targetTypes(cfg, layerId);
      const tol = cfg.targets[layerId]?.tolerancePx ?? cfg.tolerancePx;
      const wantVertex = types.includes('vertex');
      const wantEndpoint = types.includes('endpoint');

      for (const it of tree.search(box)) {
        if (excludedFeature(it)) continue;
        if (it.kind === 'vertex') {
          if (!wantVertex && !(wantEndpoint && it.isEndpoint)) continue;
          if (excludedVertex(it.layerId, it.featureId, it.path)) continue;
          const sp = projector.project(it.coord);
          const d = dist(sp, point);
          if (d > tol) continue;
          candidates.push({
            coord: cfg.inheritZ ? [...it.coord] : it.coord.slice(0, 2),
            type: it.isEndpoint && wantEndpoint ? 'endpoint' : 'vertex',
            layerId: it.layerId,
            featureId: it.featureId,
            path: it.path,
            distancePx: d,
          });
        } else {
          if (
            excludedVertex(it.layerId, it.featureId, it.pathA) ||
            excludedVertex(it.layerId, it.featureId, it.pathB)
          )
            continue;
          const sa = projector.project(it.a);
          const sb = projector.project(it.b);
          if (types.includes('intersection')) segsForIntersection.push({ it, sa, sb, types });
          if (types.includes('midpoint')) {
            const mid = lerpCoord(it.a, it.b, 0.5, cfg.inheritZ);
            const d = dist(projector.project(mid), point);
            if (d <= tol) {
              candidates.push({ coord: mid, type: 'midpoint', layerId: it.layerId, featureId: it.featureId, distancePx: d });
            }
          }
          if (types.includes('edge')) {
            const t = closestT(sa, sb, point);
            const sp = { x: sa.x + (sb.x - sa.x) * t, y: sa.y + (sb.y - sa.y) * t };
            const d = dist(sp, point);
            if (d <= tol) {
              candidates.push({
                coord: lerpCoord(it.a, it.b, t, cfg.inheritZ),
                type: 'edge',
                layerId: it.layerId,
                featureId: it.featureId,
                distancePx: d,
              });
            }
          }
        }
      }
    }

    // Intersecciones entre segmentos cercanos (de la misma o distintas capas).
    for (let i = 0; i < segsForIntersection.length; i++) {
      for (let j = i + 1; j < segsForIntersection.length; j++) {
        const s1 = segsForIntersection[i]!;
        const s2 = segsForIntersection[j]!;
        if (s1.it.layerId === s2.it.layerId && s1.it.featureId === s2.it.featureId && adjacent(s1.it, s2.it)) continue;
        const hit = intersect(s1.sa, s1.sb, s2.sa, s2.sb);
        if (!hit) continue;
        const d = dist(hit.p, point);
        const tol = Math.min(
          cfg.targets[s1.it.layerId]?.tolerancePx ?? cfg.tolerancePx,
          cfg.targets[s2.it.layerId]?.tolerancePx ?? cfg.tolerancePx,
        );
        if (d > tol) continue;
        // Si la intersección coincide con un vértice, ya se cubre como vértice.
        if (hit.t < 1e-6 || hit.t > 1 - 1e-6 || hit.u < 1e-6 || hit.u > 1 - 1e-6) continue;
        const c1 = lerpCoord(s1.it.a, s1.it.b, hit.t, true);
        const c2 = lerpCoord(s2.it.a, s2.it.b, hit.u, true);
        const z1 = c1[2];
        const z2 = c2[2];
        const zConflict = z1 !== undefined && z2 !== undefined && Math.abs(z1 - z2) > cfg.zTolerance;
        candidates.push({
          coord: cfg.inheritZ ? c1 : c1.slice(0, 2),
          type: 'intersection',
          layerId: s1.it.layerId,
          featureId: s1.it.featureId,
          distancePx: d,
          zValues: [z1, z2],
          ...(zConflict ? { zConflict } : {}),
          other: { layerId: s2.it.layerId, featureId: s2.it.featureId },
        });
      }
    }

    if (candidates.length === 0) return null;
    const priority = (layerId: string) => cfg.targets[layerId]?.priority ?? 0;
    candidates.sort((a, b) => {
      const sa = a.distancePx + TYPE_PENALTY[a.type];
      const sb = b.distancePx + TYPE_PENALTY[b.type];
      if (Math.abs(sa - sb) > 1e-9) return sa - sb;
      return priority(b.layerId) - priority(a.layerId);
    });
    return candidates[0]!;
  }

  private itemsFor(layerId: string, f: Readonly<EditorFeature>): Item[] {
    const out: Item[] = [];
    for (const v of getVertices(f.geometry)) {
      const [x, y] = v.coord as [number, number];
      out.push({ kind: 'vertex', minX: x, minY: y, maxX: x, maxY: y, layerId, featureId: f.id, coord: v.coord, path: v.path, isEndpoint: v.isEndpoint });
    }
    for (const s of getSegments(f.geometry)) {
      out.push({
        kind: 'segment',
        minX: Math.min(s.a[0]!, s.b[0]!),
        minY: Math.min(s.a[1]!, s.b[1]!),
        maxX: Math.max(s.a[0]!, s.b[0]!),
        maxY: Math.max(s.a[1]!, s.b[1]!),
        layerId,
        featureId: f.id,
        a: s.a,
        b: s.b,
        pathA: s.pathA,
        pathB: s.pathB,
      });
    }
    return out;
  }
}

function adjacent(a: SegmentItem, b: SegmentItem): boolean {
  return samePath(a.pathA, b.pathA) || samePath(a.pathA, b.pathB) || samePath(a.pathB, b.pathA) || samePath(a.pathB, b.pathB);
}

function dist(a: ScreenPoint, b: ScreenPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function closestT(a: ScreenPoint, b: ScreenPoint, p: ScreenPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return 0;
  return Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
}

function intersect(p1: ScreenPoint, p2: ScreenPoint, p3: ScreenPoint, p4: ScreenPoint): { p: ScreenPoint; t: number; u: number } | null {
  const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
  if (Math.abs(d) < 1e-12) return null;
  const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
  const u = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { p: { x: p1.x + t * (p2.x - p1.x), y: p1.y + t * (p2.y - p1.y) }, t, u };
}

/** Interpola en Web Mercator (exacto para segmentos rectos en pantalla) y la Z linealmente. */
export function lerpCoord(a: Position, b: Position, t: number, withZ: boolean): Position {
  const ma = toMercator(a);
  const mb = toMercator(b);
  const out = fromMercator([ma[0]! + (mb[0]! - ma[0]!) * t, ma[1]! + (mb[1]! - ma[1]!) * t]);
  const za = a[2];
  const zb = b[2];
  if (withZ && za !== undefined && zb !== undefined) out.push(za + (zb - za) * t);
  else if (withZ && za !== undefined && t === 0) out.push(za);
  else if (withZ && zb !== undefined && t === 1) out.push(zb);
  return out;
}

function screenBoxToLngLat(projector: Projector, p: ScreenPoint, tol: number) {
  const corners = [
    projector.unproject({ x: p.x - tol, y: p.y - tol }),
    projector.unproject({ x: p.x + tol, y: p.y - tol }),
    projector.unproject({ x: p.x - tol, y: p.y + tol }),
    projector.unproject({ x: p.x + tol, y: p.y + tol }),
  ];
  return {
    minX: Math.min(...corners.map((c) => c[0]!)),
    minY: Math.min(...corners.map((c) => c[1]!)),
    maxX: Math.max(...corners.map((c) => c[0]!)),
    maxY: Math.max(...corners.map((c) => c[1]!)),
  };
}
