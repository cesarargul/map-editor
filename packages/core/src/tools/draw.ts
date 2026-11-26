import type { Feature, Geometry, Position } from 'geojson';
import type { GeometryKind } from '../types.js';
import { pt, type SnapRequest, type Tool, type ToolContext, type ToolPointerEvent, type ToolId } from './tool.js';

type Kind = Exclude<GeometryKind, 'Mixed'>;

const TOOL_KIND: Record<string, Kind> = { 'draw-point': 'Point', 'draw-line': 'LineString', 'draw-polygon': 'Polygon' };
const LABEL: Record<Kind, string> = { Point: 'Dibujar punto', LineString: 'Dibujar línea', Polygon: 'Dibujar polígono' };

/**
 * Dibujo de puntos, líneas y polígonos.
 * Clic añade vértice · doble clic o Intro termina · Retroceso quita el último · Esc cancela.
 * En polígonos, clic sobre el primer vértice cierra.
 */
export class DrawTool implements Tool {
  readonly kind: Kind;
  private ctx!: ToolContext;
  private coords: Position[] = [];
  private hover: Position | null = null;
  private layerId: string | null = null;

  constructor(readonly id: Extract<ToolId, 'draw-point' | 'draw-line' | 'draw-polygon'>) {
    this.kind = TOOL_KIND[id]!;
  }

  activate(ctx: ToolContext): void {
    this.ctx = ctx;
    this.reset();
  }

  deactivate(): void {
    this.reset();
    this.ctx?.redraw();
  }

  snapRequest(): SnapRequest {
    return { editingLayerId: this.layerId ?? this.ctx.activeLayerId() };
  }

  onPointerMove(e: ToolPointerEvent): void {
    this.hover = e.coord;
    this.ctx.redraw();
  }

  onClick(e: ToolPointerEvent): void {
    const layerId = this.layerId ?? this.ctx.drawTarget(this.kind);
    if (!layerId) return;
    this.layerId = layerId;
    const coord = this.ctx.withZ(e.coord, layerId);

    if (this.kind === 'Point') {
      this.commit({ type: 'Point', coordinates: coord });
      return;
    }
    const last = this.coords[this.coords.length - 1];
    if (last && dist(this.ctx.projector.project(last), e.point) < 3) return; // segundo clic del doble clic
    if (this.kind === 'Polygon' && this.coords.length >= 3) {
      const first = this.ctx.projector.project(this.coords[0]!);
      if (dist(first, e.point) < 8) {
        this.finish();
        return;
      }
    }
    this.coords.push(coord);
    this.ctx.redraw();
  }

  onDoubleClick(e: ToolPointerEvent): void {
    e.preventDefault();
    this.finish();
  }

  onKeyDown(e: KeyboardEvent): boolean {
    switch (e.key) {
      case 'Enter':
        this.finish();
        return true;
      case 'Escape':
        if (this.coords.length) {
          this.reset();
          this.ctx.redraw();
        } else this.ctx.setTool('select');
        return true;
      case 'Backspace':
        if (!this.coords.length) return false;
        this.coords.pop();
        this.ctx.redraw();
        return true;
      default:
        return false;
    }
  }

  overlay(): Feature[] {
    const out: Feature[] = [];
    const pts = this.hover ? [...this.coords, this.hover] : this.coords;
    if (this.kind === 'Polygon' && pts.length >= 3) {
      out.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[...pts, pts[0]!]] }, properties: { kind: 'sketch-fill' } });
      out.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [...pts, pts[0]!] }, properties: { kind: 'sketch-line' } });
    } else if (pts.length >= 2) {
      out.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: pts }, properties: { kind: 'sketch-line' } });
    }
    this.coords.forEach((c, i) => out.push(pt(c, { kind: 'sketch-vertex', endpoint: i === 0 })));
    return out;
  }

  cursor(): string {
    return 'crosshair';
  }

  private finish(): void {
    if (this.kind === 'LineString' && this.coords.length >= 2) {
      this.commit({ type: 'LineString', coordinates: this.coords });
    } else if (this.kind === 'Polygon' && this.coords.length >= 3) {
      this.commit({ type: 'Polygon', coordinates: [[...this.coords, [...this.coords[0]!]]] });
    } else if (this.coords.length) {
      this.ctx.message('warning', this.kind === 'Polygon' ? 'Un polígono necesita al menos 3 vértices.' : 'Una línea necesita al menos 2 vértices.');
    }
  }

  private commit(geometry: Geometry): void {
    const layerId = this.layerId;
    if (!layerId) return;
    const id = this.ctx.store.transact(LABEL[this.kind], (tx) => tx.add(layerId, geometry, {}));
    this.ctx.setSelection([{ layerId, featureId: id }]);
    this.reset();
    this.ctx.redraw();
  }

  private reset(): void {
    this.coords = [];
    this.hover = null;
    this.layerId = null;
  }
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
