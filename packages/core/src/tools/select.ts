import type { Feature, Geometry, Position } from 'geojson';
import { getSegments, getVertices, insertVertex, removeVertex, setVertex, type VertexPath } from '../geom/coords.js';
import { lerpCoord } from '../snapping/snapper.js';
import type { FeatureRef, ScreenPoint } from '../types.js';
import { clone } from '../util/id.js';
import { pt, type SnapRequest, type Tool, type ToolContext, type ToolPointerEvent } from './tool.js';

type State =
  | { kind: 'idle' }
  | { kind: 'vertex'; ref: FeatureRef; path: VertexPath; geometry: Geometry; moved: boolean }
  | { kind: 'box'; start: ScreenPoint; end: ScreenPoint };

/**
 * Seleccionar (clic, Mayús+clic para añadir/quitar, Mayús+arrastrar para rectángulo)
 * y editar vértices de la entidad seleccionada:
 * arrastrar vértice, arrastrar punto medio para insertar, Alt+clic para borrar.
 *
 * Con el id `vertices` es la herramienta «Vértices»: se comporta igual, pero la interfaz muestra
 * la tabla de vértices de la entidad seleccionada y las asas se ven también en capas bloqueadas.
 */
export class SelectTool implements Tool {
  private ctx!: ToolContext;

  constructor(readonly id: 'select' | 'vertices' = 'select') {}
  private state: State = { kind: 'idle' };
  private suppressClick = false;
  /** Vértice tocado sin arrastrar: se puede borrar con `deleteActiveVertex()` (pantallas táctiles). */
  private activeVertex: { ref: FeatureRef; path: VertexPath } | null = null;

  activate(ctx: ToolContext): void {
    this.ctx = ctx;
    this.state = { kind: 'idle' };
  }

  deactivate(): void {
    this.cancel();
  }

  snapRequest(): SnapRequest | null {
    if (this.state.kind !== 'vertex') return null;
    const { ref, path } = this.state;
    return { editingLayerId: ref.layerId, excludeVertices: [{ ...ref, path }] };
  }

  /** Entidad editable seleccionada (solo si hay exactamente una). */
  private editTarget(): FeatureRef | null {
    const sel = this.ctx.getSelection();
    if (sel.length !== 1) return null;
    const ref = sel[0]!;
    return this.ctx.isEditable(ref.layerId) ? ref : null;
  }

  onPointerDown(e: ToolPointerEvent): void {
    this.suppressClick = false;
    if (e.shiftKey) {
      e.preventDefault();
      this.state = { kind: 'box', start: e.point, end: e.point };
      return;
    }
    // «Vértices» permite elegir un vértice (sin editarlo) también en una capa bloqueada
    const sel = this.ctx.getSelection();
    if (this.id === 'vertices' && sel.length === 1 && !this.ctx.isEditable(sel[0]!.layerId)) {
      const h = this.ctx.hitHandle(e.point);
      if (h?.kind === 'vertex') {
        this.suppressClick = true;
        this.setActiveVertex({ ref: sel[0]!, path: h.path });
      }
      return;
    }
    const target = this.editTarget();
    if (!target) return;
    const handle = this.ctx.hitHandle(e.point);
    if (!handle) return;
    const feature = this.ctx.store.getFeature(target.layerId, target.featureId);
    if (!feature?.geometry) return;
    e.preventDefault();
    const geometry = clone(feature.geometry);

    if (handle.kind === 'vertex' && e.altKey) {
      this.suppressClick = true;
      if (removeVertex(geometry, handle.path)) {
        this.ctx.store.transact('Borrar vértice', (tx) => tx.setGeometry(target.layerId, target.featureId, geometry));
      } else {
        this.ctx.message('warning', 'No se puede borrar: la geometría quedaría con muy pocos vértices.');
      }
      return;
    }
    if (handle.kind === 'midpoint') {
      const seg = getSegments(geometry).find((s) => samePath(s.insertPath, handle.path));
      if (!seg) return;
      insertVertex(geometry, handle.path, lerpCoord(seg.a, seg.b, 0.5, true));
    }
    this.state = { kind: 'vertex', ref: target, path: handle.path, geometry, moved: handle.kind === 'midpoint' };
    this.ctx.redraw();
  }

  onPointerMove(e: ToolPointerEvent): void {
    const s = this.state;
    if (s.kind === 'vertex') {
      setVertex(s.geometry, s.path, keepZ(e.coord, s.geometry, s.path));
      s.moved = true;
      this.ctx.preview(s.ref.layerId, s.ref.featureId, s.geometry);
      this.ctx.redraw();
    } else if (s.kind === 'box') {
      s.end = e.point;
      this.ctx.redraw();
    }
  }

  onPointerUp(): void {
    const s = this.state;
    this.state = { kind: 'idle' };
    if (s.kind === 'vertex') {
      this.suppressClick = true;
      this.setActiveVertex(s.moved ? null : { ref: s.ref, path: s.path });
      if (s.moved) {
        const geometry = this.ctx.finalizeGeometry(s.ref.layerId, s.geometry);
        this.ctx.store.transact('Editar vértice', (tx) => tx.setGeometry(s.ref.layerId, s.ref.featureId, geometry));
      }
      this.ctx.refresh(s.ref.layerId);
    } else if (s.kind === 'box') {
      this.suppressClick = true;
      if (Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y) > 3) {
        const hits = this.ctx.hitTestBox(s.start, s.end);
        const current = this.ctx.getSelection();
        const merged = [...current];
        for (const h of hits) if (!merged.some((r) => sameRef(r, h))) merged.push(h);
        this.ctx.setSelection(merged);
      }
    }
    this.ctx.redraw();
  }

  editState() {
    if (!this.ctx) return {};
    const t = this.activeVertex;
    const sel = this.ctx.getSelection();
    const valid = !!t && sel.length === 1 && sameRef(sel[0]!, t.ref);
    return { activeVertex: valid, activeVertexPath: valid ? t!.path : null };
  }

  /** Marca (o desmarca con `null`) un vértice de la entidad seleccionada, p. ej. al elegir su fila en la tabla. */
  focusVertex(ref: FeatureRef | null, path?: VertexPath): void {
    this.setActiveVertex(ref && path ? { ref, path } : null);
    this.ctx.redraw();
  }

  /** Borra el vértice activo (el último tocado sin arrastrar). */
  deleteActiveVertex(): void {
    const t = this.activeVertex;
    if (!t) return;
    const feature = this.ctx.store.getFeature(t.ref.layerId, t.ref.featureId);
    if (!feature?.geometry) return;
    const geometry = clone(feature.geometry);
    if (removeVertex(geometry, t.path)) {
      this.ctx.store.transact('Borrar vértice', (tx) => tx.setGeometry(t.ref.layerId, t.ref.featureId, geometry));
    } else {
      this.ctx.message('warning', 'No se puede borrar: la geometría quedaría con muy pocos vértices.');
    }
    this.setActiveVertex(null);
  }

  private setActiveVertex(v: { ref: FeatureRef; path: VertexPath } | null): void {
    this.activeVertex = v;
    this.ctx.stateChanged();
  }

  onClick(e: ToolPointerEvent): void {
    if (this.suppressClick) {
      this.suppressClick = false;
      return;
    }
    if (this.activeVertex) this.setActiveVertex(null);
    const hit = this.ctx.hitTest(e.point, 4)[0];
    const current = this.ctx.getSelection();
    if (!hit) {
      if (!e.shiftKey) this.ctx.setSelection([]);
      return;
    }
    if (e.shiftKey) {
      const exists = current.some((r) => sameRef(r, hit));
      this.ctx.setSelection(exists ? current.filter((r) => !sameRef(r, hit)) : [...current, hit]);
    } else {
      this.ctx.setSelection([hit]);
    }
  }

  onKeyDown(e: KeyboardEvent): boolean {
    if (e.key === 'Escape') {
      if (this.state.kind !== 'idle') this.cancel();
      else this.ctx.setSelection([]);
      return true;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.ctx.getSelection().length) {
      this.ctx.deleteSelected();
      return true;
    }
    return false;
  }

  overlay(): Feature[] {
    const out: Feature[] = [];
    const s = this.state;
    if (s.kind === 'box') {
      const { start: a, end: b } = s;
      const ring = [
        this.ctx.projector.unproject(a),
        this.ctx.projector.unproject({ x: b.x, y: a.y }),
        this.ctx.projector.unproject(b),
        this.ctx.projector.unproject({ x: a.x, y: b.y }),
        this.ctx.projector.unproject(a),
      ];
      out.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: ring }, properties: { kind: 'box' } });
      return out;
    }
    // «Vértices» también enseña las asas de una capa bloqueada (solo lectura)
    const sel = this.ctx.getSelection();
    const target = this.id === 'vertices' && sel.length === 1 ? sel[0]! : this.editTarget();
    if (!target) return out;
    const geometry = s.kind === 'vertex' ? s.geometry : this.ctx.store.getFeature(target.layerId, target.featureId)?.geometry;
    if (!geometry) return out;
    if (geometry.type !== 'Point' && geometry.type !== 'MultiPoint') {
      for (const seg of getSegments(geometry)) {
        out.push(pt(lerpCoord(seg.a, seg.b, 0.5, false), { kind: 'midpoint', path: JSON.stringify(seg.insertPath) }));
      }
    }
    for (const v of getVertices(geometry)) {
      out.push(
        pt(v.coord, {
          kind: 'vertex',
          path: JSON.stringify(v.path),
          endpoint: v.isEndpoint,
          active:
            (s.kind === 'vertex' && samePath(s.path, v.path)) ||
            (s.kind === 'idle' && !!this.activeVertex && sameRef(this.activeVertex.ref, target) && samePath(this.activeVertex.path, v.path)),
        }),
      );
    }
    return out;
  }

  cursor(): string {
    if (this.state.kind === 'vertex') return 'grabbing';
    if (this.state.kind === 'box') return 'crosshair';
    return '';
  }

  private cancel(): void {
    const s = this.state;
    this.state = { kind: 'idle' };
    if (s.kind === 'vertex') this.ctx.refresh(s.ref.layerId);
    this.ctx?.redraw();
  }
}

/**
 * La Z del vértice: la del elemento al que se engancha, si la tiene; si no, conserva la que
 * ya tenía el vértice.
 */
function keepZ(coord: Position, geometry: Geometry, path: VertexPath): Position {
  if (coord.length > 2) return coord;
  const prev = vertexAt(geometry, path);
  if (prev && prev.length > 2) return [coord[0]!, coord[1]!, prev[2]!];
  return coord;
}

function vertexAt(geometry: Geometry, path: VertexPath): Position | null {
  return getVertices(geometry).find((v) => samePath(v.path, path))?.coord ?? null;
}

export const samePath = (a: VertexPath, b: VertexPath) => a.length === b.length && a.every((v, i) => v === b[i]);
export const sameRef = (a: FeatureRef, b: FeatureRef) => a.layerId === b.layerId && a.featureId === b.featureId;
