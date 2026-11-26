import { css, html, nothing } from 'lit';
import type { Position, SnapResult, ToolId } from '@map-editor/core';
import { EditorConsumer } from '../base.js';
import { icons } from '../icons.js';
import { controls, theme } from '../styles.js';
import { TOOL_HELP } from './toolbar.js';

/** Selector de mapa base. */
export class MeBasemapSwitcher extends EditorConsumer {
  static override properties = { ...EditorConsumer.properties, open: { state: true } };
  declare open: boolean;
  static override styles = [
    theme,
    controls,
    css`
      :host {
        display: block;
        position: relative;
      }
      .menu {
        position: absolute;
        bottom: calc(100% + 6px);
        left: 0;
        min-width: 230px;
        padding: 6px;
        z-index: 5;
      }
      .group {
        margin: 6px 6px 2px;
      }
      .menu button {
        width: 100%;
        justify-content: flex-start;
      }
      .menu button[aria-checked='true'] {
        font-weight: 600;
        color: var(--me-primary);
      }
      .trigger {
        padding: 6px 10px;
      }
    `,
  ];

  constructor() {
    super();
    this.open = false;
    this.watch = ['basemap-changed'];
  }

  override render() {
    const ed = this.editor;
    if (!ed) return nothing;
    const current = ed.basemaps.find((b) => b.id === ed.getBasemap());
    const groups = [...new Set(ed.basemaps.map((b) => b.group))];
    return html`
      ${this.open
        ? html`<div class="menu panel" role="menu" @keydown=${(e: KeyboardEvent) => e.key === 'Escape' && (this.open = false)}>
            ${groups.map(
              (g) => html`<h3 class="group">${g}</h3>
                ${ed.basemaps
                  .filter((b) => b.group === g)
                  .map(
                    (b) => html`<button role="menuitemradio" aria-checked=${b.id === current?.id} @click=${() => ((this.open = false), ed.setBasemap(b.id))}>${b.name}</button>`,
                  )}`,
            )}
          </div>`
        : nothing}
      <button class="trigger panel" aria-haspopup="menu" aria-expanded=${this.open} title="Mapa base" @click=${() => (this.open = !this.open)}>
        ${icons.map} ${current?.name ?? 'Mapa base'}
      </button>
    `;
  }
}

const SNAP_TEXT: Record<SnapResult['type'], string> = {
  vertex: 'vértice',
  endpoint: 'extremo',
  edge: 'arista',
  midpoint: 'punto medio',
  intersection: 'intersección',
};

const fmt = (n: number | undefined, d: number) => (n === undefined || !Number.isFinite(n) ? '—' : n.toFixed(d));

/** Barra de estado: coordenadas, Z, snap, ayuda de la herramienta y autoguardado. */
export class MeStatusBar extends EditorConsumer {
  static override properties = { ...EditorConsumer.properties, coord: { state: true }, snap: { state: true }, savedAt: { state: true } };
  declare coord: Position | null;
  declare snap: SnapResult | null;
  declare savedAt: number | null;

  static override styles = [
    theme,
    controls,
    css`
      :host {
        display: block;
      }
      .bar {
        display: flex;
        gap: 14px;
        align-items: center;
        padding: 4px 10px;
        font-size: 12px;
        font-variant-numeric: tabular-nums;
        overflow: hidden;
        white-space: nowrap;
      }
      .help {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .snap {
        color: var(--me-primary);
      }
      .conflict {
        color: var(--me-deleted);
        font-weight: 600;
      }
      @media (max-width: 640px) {
        .help {
          display: none;
        }
      }
    `,
  ];

  constructor() {
    super();
    this.coord = null;
    this.snap = null;
    this.savedAt = null;
    this.watch = ['tool-changed'];
  }

  protected override editorBound(ed: NonNullable<this['editor']>): void {
    let frame = 0;
    this.track(
      ed.on('pointer-move', (e) => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          this.coord = e.lngLat;
          this.snap = e.snap;
        });
      }),
    );
    this.track(ed.on('autosaved', (e) => (this.savedAt = e.savedAt)));
  }

  override render() {
    const ed = this.editor;
    if (!ed) return nothing;
    const c = this.coord;
    const s = this.snap;
    const z = c?.[2];
    const zv = s?.zValues;
    return html`<div class="bar panel">
      <span>${c ? `${fmt(c[1], 6)}, ${fmt(c[0], 6)}` : '—'}${z !== undefined ? html` · Z ${fmt(z, 2)}` : nothing}</span>
      ${s
        ? s.zConflict
          ? html`<span class="conflict" title="Las geometrías se cruzan en planta pero no a la misma cota">Cruce sin conexión 3D (Z ${fmt(zv?.[0], 2)} / ${fmt(zv?.[1], 2)})</span>`
          : html`<span class="snap">⌖ ${SNAP_TEXT[s.type]} · ${ed.getLayer(s.layerId)?.name ?? ''}</span>`
        : nothing}
      <span class="help muted">${TOOL_HELP[ed.getTool() as ToolId]}</span>
      ${this.savedAt ? html`<span class="muted" title="Autoguardado en este navegador">Guardado ${new Date(this.savedAt).toLocaleTimeString()}</span>` : nothing}
    </div>`;
  }
}
