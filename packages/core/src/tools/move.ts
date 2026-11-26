import type { Feature, Geometry, Position } from 'geojson';
import { getVertices, toMercator, translateMercator } from '../geom/coords.js';
import type { FeatureRef } from '../types.js';
import { sameRef } from './select.js';
import { pt, type SnapRequest, type Tool, type ToolContext, type ToolPointerEvent } from './tool.js';

interface Drag {
  refs: FeatureRef[];
  originals: Map<string, Geometry>;
  /** Punto de anclaje (vértice más cercano al cursor) que se engancha con snapping. */
  anchor: Position;
  current: Map<string, Geometry>;
  moved: boolean;
}

const key = (r: FeatureRef) => `${r.layerId}\u0000${r.featureId}`;

/** Mover entidades: arrastrar una entidad (o la selección). El vértice más cercano al cursor se engancha. */
export class MoveTool implements Tool {
  readonly id = 'move' as const;
  private ctx!: ToolContext;
  private drag: Drag | null = null;

  activate(ctx: ToolContext): void {
    this.ctx = ctx;
  }

  deactivate(): void {
    this.cancel();
  }

  snapRequest(): SnapRequest | null {
    if (!this.drag) return null;
    return { editingLayerId: this.drag.refs[0]?.layerId ?? null, excludeFeatures: this.drag.refs };
  }

  onPointerDown(e: ToolPointerEvent): void {
    const hit = this.ctx.hitTest(e.point, 4).find((r) => this.ctx.isEditable(r.layerId));
    if (!hit) return;
    e.preventDefault();
    let sel = this.ctx.getSelection();
    if (!sel.some((r) => sameRef(r, hit))) {
      sel = e.shiftKey ? [...sel, hit] : [hit];
      this.ctx.setSelection(sel);
    }
    const refs = sel.filter((r) => this.ctx.isEditable(r.layerId));
    const originals = new Map<string, Geometry>();
    for (const r of refs) {
      const g = this.ctx.store.getFeature(r.layerId, r.featureId)?.geometry;
      if (g) originals.set(key(r), g);
    }
    // Anclaje: vértice de la entidad pulsada más cercano al cursor (si está a <15 px)
    let anchor = e.lngLat;
    let best = 15;
    for (const v of getVertices(originals.get(key(hit)) ?? null)) {
      const p = this.ctx.projector.project(v.coord);
      const d = Math.hypot(p.x - e.point.x, p.y - e.point.y);
      if (d < best) {
        best = d;
        anchor = v.coord;
      }
    }
    this.drag = { refs, originals, anchor, current: new Map(originals), moved: false };
  }

  onPointerMove(e: ToolPointerEvent): void {
    const d = this.drag;
    if (!d) return;
    const a = toMercator(d.anchor);
    const b = toMercator(e.coord);
    const dx = b[0]! - a[0]!;
    const dy = b[1]! - a[1]!;
    d.moved = true;
    for (const r of d.refs) {
      const orig = d.originals.get(key(r));
      if (!orig) continue;
      const g = translateMercator(orig, dx, dy);
      d.current.set(key(r), g);
      this.ctx.preview(r.layerId, r.featureId, g);
    }
    this.ctx.redraw();
  }

  onPointerUp(): void {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (d.moved) {
      const n = d.refs.length;
      this.ctx.store.transact(n === 1 ? 'Mover entidad' : `Mover ${n} entidades`, (tx) => {
        for (const r of d.refs) {
          const g = d.current.get(key(r));
          if (g) tx.setGeometry(r.layerId, r.featureId, g);
        }
      });
    }
    for (const layerId of new Set(d.refs.map((r) => r.layerId))) this.ctx.refresh(layerId);
    this.ctx.redraw();
  }

  onKeyDown(e: KeyboardEvent): boolean {
    if (e.key === 'Escape') {
      if (this.drag) this.cancel();
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
    return this.drag ? [pt(this.drag.anchor, { kind: 'vertex', active: true })] : [];
  }

  cursor(): string {
    return this.drag ? 'grabbing' : 'move';
  }

  private cancel(): void {
    const d = this.drag;
    this.drag = null;
    if (d) for (const layerId of new Set(d.refs.map((r) => r.layerId))) this.ctx.refresh(layerId);
    this.ctx?.redraw();
  }
}
