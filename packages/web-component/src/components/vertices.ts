import { css, html, nothing } from 'lit';
import { live } from 'lit/directives/live.js';
import { describeVertices, lengthM, transformPosition, type EditorFeature, type FeatureRef, type LayerInfo, type VertexRow } from '@map-editor/core';
import { EditorConsumer } from '../base.js';
import { icons } from '../icons.js';
import { controls, theme } from '../styles.js';

const GEOGRAPHIC = new Set(['EPSG:4326', 'EPSG:4258', 'EPSG:4230', 'EPSG:4081']);
const KIND_LABEL = { point: 'Punto', endpoint: 'Extremo', vertex: 'Vértice' } as const;
const PAGE_SIZE = 100;

const samePath = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i]);
const fmtM = (m: number) => (m >= 10000 ? `${(m / 1000).toFixed(3)} km` : `${m.toFixed(2)} m`);

/** ¿Sabe proj4 convertir a este sistema? (algunos CRS de un WKT desconocido no se pueden usar). */
const crsUsable = new Map<string, boolean>();
function canConvert(code: string): boolean {
  let ok = crsUsable.get(code);
  if (ok === undefined) {
    try {
      const p = transformPosition([-3.7, 40.4], 'EPSG:4326', code);
      ok = Number.isFinite(p[0]) && Number.isFinite(p[1]);
    } catch {
      ok = false;
    }
    crsUsable.set(code, ok);
  }
  return ok;
}

interface Data {
  ref: FeatureRef;
  layer: LayerInfo;
  feature: EditorFeature;
  rows: VertexRow[];
  crs: string;
  activeIndex: number;
}

/**
 * Tabla de vértices de la entidad seleccionada (herramienta «Vértices»): lista sus coordenadas, que
 * se pueden editar directamente, y permite localizar, insertar y borrar vértices. Cada cambio es una
 * transacción del editor (se puede deshacer). Las coordenadas se muestran en el sistema de la capa
 * (o en WGS84) y solo se modifica lo que se edita.
 */
export class MeVertexTable extends EditorConsumer {
  static override properties = { ...EditorConsumer.properties, wgs84: { state: true }, page: { state: true } };
  declare wgs84: boolean;
  declare page: number;
  private data: Data | { empty: string } | null = null;
  private lastActiveKey = '';

  static override styles = [
    theme,
    controls,
    css`
      :host {
        display: flex;
        flex-direction: column;
        min-height: 0;
        min-width: 0;
      }
      header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 10px;
        border-bottom: 1px solid var(--me-border);
        flex-wrap: wrap;
      }
      header h3 {
        min-width: 0;
        order: 0;
      }
      header .spacer {
        flex: 1;
        order: 1;
      }
      header .pager,
      header .close {
        order: 2;
      }
      /* El resumen y el sistema de coordenadas van en una segunda línea */
      header .meta-row {
        order: 3;
        flex: 1 0 100%;
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .badge.ro {
        background: var(--me-fg-muted);
      }
      .empty {
        padding: 14px 12px;
      }
      .scroll {
        overflow: auto;
        flex: 1;
        min-height: 0;
        min-width: 0;
        -webkit-overflow-scrolling: touch;
        overscroll-behavior: contain;
        touch-action: pan-x pan-y;
      }
      table {
        border-collapse: collapse;
        width: max-content;
        min-width: 100%;
      }
      th,
      td {
        border-bottom: 1px solid var(--me-border);
        padding: 2px 6px;
        text-align: left;
        white-space: nowrap;
      }
      th {
        position: sticky;
        top: 0;
        background: var(--me-bg-alt);
        font-weight: 600;
        z-index: 1;
        height: 30px;
      }
      th small {
        font-weight: normal;
        color: var(--me-fg-muted);
      }
      tr {
        scroll-margin-top: 32px;
      }
      tr:hover td {
        background: var(--me-bg-alt);
      }
      tr.active td {
        background: color-mix(in srgb, #ffb400 28%, transparent);
      }
      td.num,
      td.info {
        font-variant-numeric: tabular-nums;
      }
      td.num {
        color: var(--me-fg-muted);
        text-align: right;
      }
      td.info {
        color: var(--me-fg-muted);
        text-align: right;
      }
      td.act {
        padding: 0 2px;
      }
      td.act button {
        padding: 5px;
      }
      td.act svg {
        width: 17px;
        height: 17px;
      }
      td input {
        width: 9.5em;
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      td input.z {
        width: 7em;
      }
      td input:disabled {
        background: transparent;
        border-color: transparent;
        color: inherit;
        opacity: 0.85;
      }
      .na {
        color: var(--me-fg-muted);
        padding: 0 8px;
      }
      .visually {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip: rect(0 0 0 0);
      }
    `,
  ];

  constructor() {
    super();
    this.wgs84 = false;
    this.page = 0;
    this.watch = ['selection-changed', 'features-changed', 'edit-state-changed', 'layers-changed', 'active-layer-changed'];
  }

  private displayCrs(layer: LayerInfo): string {
    if (this.wgs84) return 'EPSG:4326';
    return canConvert(layer.source.crs) ? layer.source.crs : 'EPSG:4326';
  }

  protected override willUpdate(): void {
    const ed = this.editor;
    this.data = null;
    if (!ed) return;
    const sel = ed.getSelection();
    if (sel.length !== 1) {
      this.data = { empty: sel.length === 0 ? 'Selecciona una entidad (clic en el mapa) para ver y editar sus vértices.' : `Hay ${sel.length} entidades seleccionadas: selecciona solo una para ver sus vértices.` };
      return;
    }
    const ref = sel[0]!;
    const layer = ed.getLayer(ref.layerId);
    const feature = ed.store.getFeature(ref.layerId, ref.featureId);
    if (!layer || !feature) return;
    if (!feature.geometry) {
      this.data = { empty: 'La entidad seleccionada no tiene geometría.' };
      return;
    }
    const rows = describeVertices(feature.geometry);
    const active = ed.getEditState().activeVertexPath;
    const activeIndex = active ? rows.findIndex((r) => samePath(r.path, active)) : -1;
    this.data = { ref, layer, feature, rows, crs: this.displayCrs(layer), activeIndex };

    // Mostrar la página donde está el vértice activo cuando cambia (p. ej. al tocarlo en el mapa)
    const key = activeIndex >= 0 ? `${ref.layerId}:${ref.featureId}:${active!.join(',')}` : '';
    if (key !== this.lastActiveKey && activeIndex >= 0) this.page = Math.floor(activeIndex / PAGE_SIZE);
    const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    if (this.page >= pages) this.page = pages - 1;
  }

  protected override updated(): void {
    const d = this.data;
    const active = d && 'rows' in d && d.activeIndex >= 0 ? d.rows[d.activeIndex]!.path.join(',') : '';
    const key = active && d && 'ref' in d ? `${d.ref.layerId}:${d.ref.featureId}:${active}` : '';
    if (key !== this.lastActiveKey) {
      this.lastActiveKey = key;
      if (key) this.renderRoot.querySelector('tr.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  override render() {
    const ed = this.editor;
    const d = this.data;
    if (!ed || !d) return nothing;
    if ('empty' in d) return html`${this.renderHeader()}<div class="empty muted">${d.empty}</div>`;

    const { ref, layer, feature, rows, crs, activeIndex } = d;
    const geo = GEOGRAPHIC.has(crs);
    const decimals = geo ? 7 : 3;
    const editable = layer.editable;
    const hasZ = layer.source.hasZ;
    const hasParts = rows.some((r) => r.part !== '');
    const hasDist = rows.some((r) => r.dist !== null);
    const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    const slice = rows.slice(this.page * PAGE_SIZE, (this.page + 1) * PAGE_SIZE);
    const length = lengthM(feature.geometry);

    return html`
      ${this.renderHeader(layer, feature, rows.length, length, pages)}
      <div class="scroll">
        <table aria-label="Vértices de la entidad seleccionada">
          <thead>
            <tr>
              <th>#</th>
              <th>${geo ? 'Lon' : 'X'}</th>
              <th>${geo ? 'Lat' : 'Y'}</th>
              <th>Z <small>m</small></th>
              <th><span class="visually">Acciones</span></th>
              ${hasParts ? html`<th>Parte</th>` : nothing}
              <th>Tipo</th>
              ${hasDist ? html`<th>Δ <small>anterior</small></th><th>Σ <small>acumulada</small></th>` : nothing}
            </tr>
          </thead>
          <tbody>
            ${slice.map((row, i) => {
              const gi = this.page * PAGE_SIZE + i;
              const p = transformPosition(row.coord, 'EPSG:4326', crs);
              const n = row.index;
              const rowLabel = row.part ? `${n} (${row.part})` : String(n);
              return html`<tr class=${gi === activeIndex ? 'active' : ''} @click=${() => ed.focusVertex(ref.layerId, ref.featureId, row.path, true)}>
                <td class="num">${n}</td>
                <td>${this.numInput(`${geo ? 'Longitud' : 'X'} del vértice ${rowLabel}`, p[0], decimals, !editable, (v) => ed.updateVertex(ref.layerId, ref.featureId, row.path, { x: v }, crs))}</td>
                <td>${this.numInput(`${geo ? 'Latitud' : 'Y'} del vértice ${rowLabel}`, p[1], decimals, !editable, (v) => ed.updateVertex(ref.layerId, ref.featureId, row.path, { y: v }, crs))}</td>
                <td>
                  ${hasZ
                    ? this.numInput(`Z del vértice ${rowLabel}`, row.coord[2], 3, !editable, (v) => ed.updateVertex(ref.layerId, ref.featureId, row.path, { z: v }, crs), 'z')
                    : html`<span class="na" title="La capa es 2D">—</span>`}
                </td>
                <td class="act">
                  <button class="icon" title="Ir al vértice" aria-label="Ir al vértice ${rowLabel}" @click=${(e: Event) => (e.stopPropagation(), ed.focusVertex(ref.layerId, ref.featureId, row.path), ed.zoomToVertex(ref.layerId, ref.featureId, row.path))}>${icons.zoom}</button>
                  ${editable
                    ? html`<button class="icon" title="Insertar un vértice después de este" aria-label="Insertar vértice después del ${rowLabel}" ?disabled=${!row.hasNext} @click=${(e: Event) => (e.stopPropagation(), ed.insertVertexAfter(ref.layerId, ref.featureId, row.path))}>${icons.plus}</button>
                      <button class="icon" title="Borrar vértice" aria-label="Borrar vértice ${rowLabel}" @click=${(e: Event) => (e.stopPropagation(), ed.deleteVertex(ref.layerId, ref.featureId, row.path))}>${icons.trash}</button>`
                    : nothing}
                </td>
                ${hasParts ? html`<td class="info" style="text-align:left">${row.part}</td>` : nothing}
                <td class="info" style="text-align:left">${KIND_LABEL[row.kind]}</td>
                ${hasDist ? html`<td class="info">${row.dist === null ? '' : fmtM(row.dist)}</td><td class="info">${row.dist === null ? '' : fmtM(row.cum)}</td>` : nothing}
              </tr>`;
            })}
          </tbody>
        </table>
      </div>
    `;
  }

  private renderHeader(layer?: LayerInfo, feature?: EditorFeature, count = 0, length = 0, pages = 1) {
    const geomType = feature?.geometry?.type;
    const projected = layer && canConvert(layer.source.crs) && !GEOGRAPHIC.has(layer.source.crs);
    return html`<header>
      <h3>Vértices${layer ? html` · ${layer.name}` : nothing}</h3>
      ${layer && feature
        ? html`<div class="meta-row">
            <span class="muted">${geomType} · ${count} vértice${count === 1 ? '' : 's'}${length > 0 ? ` · ${fmtM(length)}` : ''}</span>
            ${layer.editable ? nothing : html`<span class="badge ro" title="La capa está bloqueada">Solo lectura</span>`}
            ${layer.source.crs !== 'EPSG:4326' && canConvert(layer.source.crs)
              ? html`<select aria-label="Sistema de coordenadas" @change=${(e: Event) => (this.wgs84 = (e.target as HTMLSelectElement).value === 'wgs84')}>
                  <option value="layer" ?selected=${!this.wgs84}>${layer.source.crs}${projected ? ' (capa)' : ''}</option>
                  <option value="wgs84" ?selected=${this.wgs84}>WGS84 · EPSG:4326</option>
                </select>`
              : nothing}
          </div>`
        : nothing}
      <span class="spacer"></span>
      ${pages > 1
        ? html`<span class="pager"
            ><button ?disabled=${this.page === 0} aria-label="Página anterior" @click=${() => (this.page = this.page - 1)}>‹</button>
            <span>${this.page + 1} / ${pages}</span>
            <button ?disabled=${this.page >= pages - 1} aria-label="Página siguiente" @click=${() => (this.page = this.page + 1)}>›</button></span
          >`
        : nothing}
      <button class="icon close" title="Cerrar la tabla de vértices" aria-label="Cerrar tabla de vértices" @click=${() => this.fire('me-close-vertices')}>${icons.close}</button>
    </header>`;
  }

  /** Celda numérica editable: solo se confirma al terminar de editar y un valor no válido se descarta. */
  private numInput(label: string, value: number | undefined, decimals: number, disabled: boolean, commit: (v: number) => boolean, cls = '') {
    const text = value === undefined || !Number.isFinite(value) ? '' : value.toFixed(decimals);
    return html`<input
      class=${cls}
      type="number"
      step="any"
      inputmode="decimal"
      aria-label=${label}
      .value=${live(text)}
      ?disabled=${disabled}
      @click=${(e: Event) => e.stopPropagation()}
      @change=${(e: Event) => {
        const el = e.target as HTMLInputElement;
        const v = Number.parseFloat(el.value);
        if (el.value.trim() === '' || !Number.isFinite(v) || !commit(v)) {
          el.value = text; // descartar el valor no válido
          this.requestUpdate();
        }
      }}
    />`;
  }
}
