import { css, html, nothing } from 'lit';
import type { GeometryKind, LayerInfo } from '@map-editor/core';
import { SUPPORTED_EXTENSIONS } from '@map-editor/core';
import { EditorConsumer } from '../base.js';
import { icons } from '../icons.js';
import { controls, theme } from '../styles.js';

const KIND_LABEL: Record<GeometryKind, string> = { Point: 'Puntos', LineString: 'Líneas', Polygon: 'Polígonos', Mixed: 'Mixta' };

/** Panel de capas: visibilidad, capa activa, color, orden, exportar y abrir ficheros. */
export class MeLayerPanel extends EditorConsumer {
  static override properties = { ...EditorConsumer.properties, renaming: { state: true }, creating: { state: true } };
  declare renaming: string | null;
  declare creating: boolean;

  static override styles = [
    theme,
    controls,
    css`
      :host {
        display: block;
      }
      header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 4px;
        padding: 8px 8px 4px 12px;
      }
      ul {
        list-style: none;
        margin: 0;
        padding: 4px;
        max-height: 40vh;
        overflow: auto;
      }
      li {
        display: grid;
        grid-template-columns: auto auto 1fr auto;
        align-items: center;
        gap: 6px;
        padding: 4px 6px;
        border-radius: 6px;
        border: 1px solid transparent;
      }
      li.active {
        border-color: var(--me-primary);
        background: color-mix(in srgb, var(--me-primary) 8%, transparent);
      }
      .name {
        cursor: pointer;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        min-width: 0;
      }
      .name small {
        display: block;
        color: var(--me-fg-muted);
        font-size: 11px;
        white-space: normal;
      }
      input[type='color'] {
        width: 22px;
        height: 22px;
        padding: 0;
        border: none;
        background: none;
      }
      .actions {
        display: flex;
        gap: 0;
      }
      .actions button {
        padding: 3px;
      }
      .actions svg {
        width: 16px;
        height: 16px;
      }
      .empty {
        padding: 12px;
        text-align: center;
      }
      .create {
        display: flex;
        gap: 4px;
        padding: 0 8px 8px;
        flex-wrap: wrap;
      }
      input[type='file'] {
        display: none;
      }
    `,
  ];

  constructor() {
    super();
    this.renaming = null;
    this.creating = false;
    this.watch = ['layers-changed', 'active-layer-changed', 'features-changed'];
  }

  override render() {
    const ed = this.editor;
    if (!ed) return html``;
    const layers = ed.getLayers().slice().reverse();
    const active = ed.getActiveLayerId();
    return html`
      <header>
        <h3>Capas</h3>
        <div>
          <button class="icon" title="Abrir ficheros" aria-label="Abrir ficheros" @click=${() => this.renderRoot.querySelector<HTMLInputElement>('input[type=file]')!.click()}>
            ${icons.upload}
          </button>
          <button class="icon" title="Nueva capa" aria-label="Nueva capa" @click=${() => (this.creating = !this.creating)}>${icons.plus}</button>
        </div>
        <input type="file" multiple accept=${SUPPORTED_EXTENSIONS.map((e) => '.' + e).join(',')} @change=${this.onFiles} />
      </header>
      ${this.creating
        ? html`<div class="create">
            ${(['Point', 'LineString', 'Polygon'] as const).map(
              (k) => html`<button class="outline" @click=${() => this.create(k)}>${KIND_LABEL[k]}</button>`,
            )}
          </div>`
        : nothing}
      ${layers.length
        ? html`<ul>
            ${layers.map((l, i) => this.renderLayer(l, l.id === active, i === 0, i === layers.length - 1))}
          </ul>`
        : html`<p class="empty muted">Arrastra aquí ficheros GeoJSON, Shapefile (.zip), KML, GPX, GeoPackage o FlatGeobuf, o crea una capa nueva.</p>`}
    `;
  }

  private renderLayer(l: LayerInfo, active: boolean, top: boolean, bottom: boolean) {
    const ed = this.editor!;
    const count = ed.store.featureCount(l.id);
    const ch = ed.store.changeSummary(l.id);
    const crs = l.source.crs + (l.source.crsGuessed ? ' (supuesto)' : '');
    return html`<li class=${active ? 'active' : ''}>
      <button class="icon" title=${l.visible ? 'Ocultar' : 'Mostrar'} aria-label=${l.visible ? 'Ocultar capa' : 'Mostrar capa'} @click=${() => ed.setLayerVisible(l.id, !l.visible)}>
        ${l.visible ? icons.eye : icons.eyeOff}
      </button>
      <input type="color" .value=${l.style.color} title="Color" aria-label="Color de la capa" @input=${(e: Event) => ed.updateLayer(l.id, { style: { ...l.style, color: (e.target as HTMLInputElement).value } })} />
      <div class="name" title="${l.name} · ${crs}${l.source.hasZ ? ' · 3D' : ''}" @click=${() => ed.setActiveLayer(l.id)} @dblclick=${() => (this.renaming = l.id)}>
        ${this.renaming === l.id
          ? html`<input
              .value=${l.name}
              @keydown=${(e: KeyboardEvent) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') this.renaming = null;
              }}
              @blur=${(e: Event) => {
                const v = (e.target as HTMLInputElement).value.trim();
                if (v && this.renaming) ed.updateLayer(l.id, { name: v });
                this.renaming = null;
              }}
            />`
          : html`${l.name}`}
        <small>
          ${KIND_LABEL[l.geometryKind]} · ${count} ${l.source.hasZ ? '· 3D' : ''} · ${l.source.crs}
          ${ch.new ? html`<span class="badge new" title="Nuevas">+${ch.new}</span>` : nothing}
          ${ch.modified ? html`<span class="badge modified" title="Modificadas">~${ch.modified}</span>` : nothing}
          ${ch.deleted ? html`<span class="badge deleted" title="Borradas">−${ch.deleted}</span>` : nothing}
        </small>
      </div>
      <div class="actions">
        <button title="Subir" aria-label="Subir capa" ?disabled=${top} @click=${() => this.move(l.id, 1)}>${icons.up}</button>
        <button title="Bajar" aria-label="Bajar capa" ?disabled=${bottom} @click=${() => this.move(l.id, -1)}>${icons.down}</button>
        <button title="Zoom a la capa" aria-label="Zoom a la capa" @click=${() => ed.zoomToLayer(l.id)}>${icons.zoom}</button>
        <button title=${l.editable ? 'Bloquear edición' : 'Permitir edición'} aria-label="Bloquear edición" @click=${() => ed.updateLayer(l.id, { editable: !l.editable })}>
          ${l.editable ? icons.unlock : icons.lock}
        </button>
        <button title="Descargar" aria-label="Descargar capa" @click=${() => this.fire('me-open-export', { layerId: l.id })}>${icons.download}</button>
        <button title="Quitar capa" aria-label="Quitar capa" @click=${() => this.removeLayer(l)}>${icons.close}</button>
      </div>
    </li>`;
  }

  private onFiles = (e: Event) => {
    const input = e.target as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = '';
    if (files.length) void this.editor?.loadFiles(files);
  };

  private create(kind: Exclude<GeometryKind, 'Mixed'>) {
    const name = { Point: 'Puntos', LineString: 'Líneas', Polygon: 'Polígonos' }[kind];
    const n = (this.editor?.getLayers().length ?? 0) + 1;
    this.editor?.createLayer(`${name} ${n}`, kind);
    this.editor?.setTool(kind === 'Point' ? 'draw-point' : kind === 'LineString' ? 'draw-line' : 'draw-polygon');
    this.creating = false;
  }

  private move(id: string, dir: 1 | -1) {
    const ed = this.editor!;
    const order = ed.getLayers().map((l) => l.id);
    const i = order.indexOf(id);
    const j = i + dir;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j]!, order[i]!];
    ed.reorderLayers(order);
  }

  private removeLayer(l: LayerInfo) {
    const ch = this.editor!.store.changeSummary(l.id);
    const pending = ch.new + ch.modified + ch.deleted;
    if (pending && !confirm(`La capa "${l.name}" tiene ${pending} cambios sin descargar. ¿Quitarla igualmente?`)) return;
    this.editor!.removeLayer(l.id);
  }
}
