import { css, html, nothing } from 'lit';
import type { EditorFeature, FieldDef, FieldType, LayerInfo } from '@map-editor/core';
import { getVertices, hasZ } from '@map-editor/core';
import { EditorConsumer } from '../base.js';
import { icons } from '../icons.js';
import { controls, theme } from '../styles.js';

const STATUS_LABEL = { original: 'Sin cambios', new: 'Nueva', modified: 'Modificada', deleted: 'Borrada' } as const;
const TYPE_LABEL: Record<FieldType, string> = { string: 'Texto', integer: 'Entero', number: 'Decimal', boolean: 'Sí/No', date: 'Fecha' };

export function parseValue(type: FieldType, raw: string | boolean): unknown {
  if (typeof raw === 'boolean') return raw;
  if (raw === '') return null;
  switch (type) {
    case 'integer': {
      const n = Number.parseInt(raw, 10);
      return Number.isFinite(n) ? n : null;
    }
    case 'number': {
      const n = Number(raw.replace(',', '.'));
      return Number.isFinite(n) ? n : null;
    }
    default:
      return raw;
  }
}

export function fieldInput(field: FieldDef, value: unknown, onChange: (v: unknown) => void, disabled = false) {
  const set = (e: Event) => {
    const el = e.target as HTMLInputElement;
    onChange(parseValue(field.type, field.type === 'boolean' ? el.checked : el.value));
  };
  switch (field.type) {
    case 'boolean':
      return html`<input type="checkbox" aria-label=${field.name} .checked=${value === true} ?disabled=${disabled} @change=${set} />`;
    case 'integer':
      return html`<input type="number" step="1" aria-label=${field.name} .value=${value == null ? '' : String(value)} ?disabled=${disabled} @change=${set} />`;
    case 'number':
      return html`<input type="number" step="any" aria-label=${field.name} .value=${value == null ? '' : String(value)} ?disabled=${disabled} @change=${set} />`;
    case 'date':
      return html`<input type="date" aria-label=${field.name} .value=${value == null ? '' : String(value).slice(0, 10)} ?disabled=${disabled} @change=${set} />`;
    default:
      return html`<input type="text" aria-label=${field.name} .value=${value == null ? '' : String(value)} ?disabled=${disabled} @change=${set} />`;
  }
}

/** Formulario de atributos de la entidad seleccionada y gestión de campos. */
export class MeAttributePanel extends EditorConsumer {
  static override properties = { ...EditorConsumer.properties, addingField: { state: true }, dismissible: { type: Boolean }, collapsed: { type: Boolean } };
  declare addingField: boolean;
  /** Pantallas estrechas: muestra los botones para plegar y cerrar el panel. */
  declare dismissible: boolean;
  /** Solo se ve la cabecera (nombre de la capa y estado), para no tapar el mapa. */
  declare collapsed: boolean;

  static override styles = [
    theme,
    controls,
    css`
      :host {
        display: flex;
        flex-direction: column;
        min-height: 0;
        overflow: hidden;
      }
      .wrap {
        padding: 8px 12px 12px;
        flex: 1 1 auto;
        min-height: 0;
        overflow: auto;
      }
      .wrap.collapsed {
        padding-bottom: 6px;
      }
      .wrap.collapsed header {
        margin-bottom: 0;
      }
      .head-actions {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 6px;
      }
      form {
        display: grid;
        grid-template-columns: minmax(70px, auto) 1fr;
        gap: 4px 8px;
        align-items: center;
      }
      label {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--me-fg-muted);
      }
      .meta {
        font-size: 11px;
        margin: 6px 0;
      }
      .add {
        display: flex;
        gap: 4px;
        margin-top: 8px;
      }
      .add input {
        flex: 1;
      }
    `,
  ];

  constructor() {
    super();
    this.addingField = false;
    this.dismissible = false;
    this.collapsed = false;
    this.watch = ['selection-changed', 'features-changed', 'layers-changed'];
  }

  override render() {
    const ed = this.editor;
    if (!ed) return html``;
    const sel = ed.getSelection();
    if (sel.length === 0) return html`<div class="wrap muted">Selecciona una entidad para ver y editar sus atributos.</div>`;
    if (sel.length > 1) {
      return html`<div class="wrap ${this.collapsed ? 'collapsed' : ''}">
        <header><h3>${sel.length} entidades seleccionadas</h3><span class="head-actions">${this.toggleButton()}${this.closeButton()}</span></header>
        ${this.collapsed ? nothing : html`<button class="outline" @click=${() => ed.deleteSelected()}>${icons.trash} Borrar selección</button>`}
      </div>`;
    }
    const ref = sel[0]!;
    const layer = ed.getLayer(ref.layerId);
    const f = ed.store.getFeature(ref.layerId, ref.featureId);
    if (!layer || !f) return html``;
    const editable = layer.editable;
    return html`<div class="wrap ${this.collapsed ? 'collapsed' : ''}">
      <header>
        <h3>Atributos · ${layer.name}</h3>
        <span class="head-actions">
          <span class="badge ${f.status}" title="Estado">${f.status === 'original' ? nothing : STATUS_LABEL[f.status]}</span>
          ${this.toggleButton()}${this.closeButton()}
        </span>
      </header>
      ${this.collapsed
        ? nothing
        : html`${this.geometryInfo(f)}
            <form @submit=${(e: Event) => e.preventDefault()}>
              ${layer.fields.map(
                (fd) => html`<label title="${fd.name} (${TYPE_LABEL[fd.type]})">${fd.name}</label>
                  ${fieldInput(fd, f.properties[fd.name], (v) => ed.setFeatureProperties(ref.layerId, ref.featureId, { [fd.name]: v }), !editable)}`,
              )}
            </form>
            ${editable ? this.renderAddField(layer) : nothing}`}
    </div>`;
  }

  private toggleButton() {
    return this.dismissible
      ? html`<button class="icon" title=${this.collapsed ? 'Mostrar atributos' : 'Ocultar atributos'} aria-label=${this.collapsed ? 'Mostrar atributos' : 'Ocultar atributos'} aria-expanded=${!this.collapsed} @click=${() => this.fire('me-toggle-attributes')}>
          ${this.collapsed ? icons.up : icons.down}
        </button>`
      : nothing;
  }

  private closeButton() {
    return this.dismissible
      ? html`<button class="icon" title="Cerrar atributos" aria-label="Cerrar atributos" @click=${() => this.fire('me-close-attributes')}>${icons.close}</button>`
      : nothing;
  }

  private geometryInfo(f: EditorFeature) {
    if (!f.geometry) return html`<p class="meta muted">Sin geometría</p>`;
    const n = getVertices(f.geometry).length;
    const z = hasZ(f.geometry);
    const zs = z ? getVertices(f.geometry).map((v) => v.coord[2]!).filter(Number.isFinite) : [];
    const zText = zs.length ? ` · Z ${Math.min(...zs).toFixed(2)}–${Math.max(...zs).toFixed(2)}` : '';
    return html`<p class="meta muted">${f.geometry.type} · ${n} vértice${n === 1 ? '' : 's'}${zText}</p>`;
  }

  private renderAddField(layer: LayerInfo) {
    if (!this.addingField) {
      return html`<div class="add"><button class="outline" @click=${() => (this.addingField = true)}>${icons.plus} Añadir campo</button></div>`;
    }
    return html`<div class="add">
      <input placeholder="Nombre del campo" aria-label="Nombre del campo" />
      <select aria-label="Tipo">
        ${Object.entries(TYPE_LABEL).map(([k, v]) => html`<option value=${k}>${v}</option>`)}
      </select>
      <button
        class="primary"
        @click=${() => {
          const name = this.renderRoot.querySelector<HTMLInputElement>('.add input')!.value.trim();
          const type = this.renderRoot.querySelector<HTMLSelectElement>('.add select')!.value as FieldType;
          if (!name) return;
          if (layer.fields.some((f) => f.name === name)) {
            this.editor!.message('warning', `Ya existe el campo "${name}".`);
            return;
          }
          this.editor!.setLayerFields(layer.id, [...layer.fields, { name, type }]);
          this.addingField = false;
        }}
      >
        Añadir
      </button>
      <button @click=${() => (this.addingField = false)}>Cancelar</button>
    </div>`;
  }
}

/** Tabla de atributos de la capa activa, con edición en línea y paginación. */
export class MeAttributeTable extends EditorConsumer {
  static override properties = { ...EditorConsumer.properties, page: { state: true }, filter: { state: true }, editing: { state: true } };
  declare page: number;
  declare filter: 'all' | 'selected' | 'changes';
  declare editing: string | null;
  private pageSize = 100;

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
      }
      header .spacer {
        flex: 1;
      }
      .scroll {
        overflow: auto;
        flex: 1;
        min-height: 0;
        min-width: 0;
        /* Desplazamiento táctil en ambos ejes sin arrastrar la página ni el mapa */
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
        padding: 3px 8px;
        text-align: left;
        white-space: nowrap;
        max-width: 260px;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      th {
        position: sticky;
        top: 0;
        background: var(--me-bg-alt);
        font-weight: 600;
        z-index: 1;
      }
      th small {
        font-weight: normal;
        color: var(--me-fg-muted);
      }
      tr.selected td {
        background: color-mix(in srgb, #ffb400 25%, transparent);
      }
      tr:hover td {
        background: var(--me-bg-alt);
      }
      td.status {
        width: 1%;
      }
      td input {
        width: 100%;
        min-width: 80px;
      }
    `,
  ];

  constructor() {
    super();
    this.page = 0;
    this.filter = 'all';
    this.editing = null;
    this.watch = ['active-layer-changed', 'features-changed', 'selection-changed', 'layers-changed'];
  }

  override render() {
    const ed = this.editor;
    const layerId = ed?.getActiveLayerId();
    const layer = layerId ? ed!.getLayer(layerId) : null;
    if (!ed || !layer) return html`<header><h3>Tabla de atributos</h3><span class="muted">No hay capa activa</span></header>`;
    const selected = new Set(ed.getSelection().filter((r) => r.layerId === layer.id).map((r) => r.featureId));
    let rows = ed.store.getFeatures(layer.id, { includeDeleted: this.filter === 'changes' });
    if (this.filter === 'selected') rows = rows.filter((f) => selected.has(f.id));
    if (this.filter === 'changes') rows = rows.filter((f) => f.status !== 'original');
    const pages = Math.max(1, Math.ceil(rows.length / this.pageSize));
    const page = Math.min(this.page, pages - 1);
    const slice = rows.slice(page * this.pageSize, (page + 1) * this.pageSize);
    return html`
      <header>
        <h3>${layer.name}</h3>
        <span class="muted">${rows.length} filas</span>
        <select aria-label="Filtro" .value=${this.filter} @change=${(e: Event) => ((this.filter = (e.target as HTMLSelectElement).value as never), (this.page = 0))}>
          <option value="all">Todas</option>
          <option value="selected">Seleccionadas</option>
          <option value="changes">Con cambios</option>
        </select>
        <span class="spacer"></span>
        ${pages > 1
          ? html`<button ?disabled=${page === 0} @click=${() => (this.page = page - 1)}>‹</button>
              <span>${page + 1} / ${pages}</span>
              <button ?disabled=${page >= pages - 1} @click=${() => (this.page = page + 1)}>›</button>`
          : nothing}
        <button class="icon" title="Cerrar tabla" aria-label="Cerrar tabla" @click=${() => this.fire('me-close-table')}>${icons.close}</button>
      </header>
      <div class="scroll">
        <table>
          <thead>
            <tr>
              <th></th>
              ${layer.fields.map((f) => html`<th>${f.name} <small>${TYPE_LABEL[f.type]}</small></th>`)}
            </tr>
          </thead>
          <tbody>
            ${slice.map((f) => this.renderRow(layer, f, selected.has(f.id)))}
          </tbody>
        </table>
      </div>
    `;
  }

  private renderRow(layer: LayerInfo, f: Readonly<EditorFeature>, isSelected: boolean) {
    const ed = this.editor!;
    const ref = { layerId: layer.id, featureId: f.id };
    return html`<tr
      class=${isSelected ? 'selected' : ''}
      @click=${(e: MouseEvent) => {
        if (f.status === 'deleted') return;
        const sel = ed.getSelection();
        ed.setSelection(e.shiftKey || e.ctrlKey || e.metaKey ? [...sel, ref] : [ref]);
      }}
      @dblclick=${() => this.zoomTo(f)}
    >
      <td class="status">${f.status !== 'original' ? html`<span class="badge ${f.status}">${STATUS_LABEL[f.status]}</span>` : nothing}</td>
      ${layer.fields.map((fd) => {
        const key = `${f.id}:${fd.name}`;
        const v = f.properties[fd.name];
        if (this.editing === key && layer.editable && f.status !== 'deleted') {
          return html`<td @click=${(e: Event) => e.stopPropagation()}>
            ${fieldInput(fd, v, (nv) => {
              ed.setFeatureProperties(layer.id, f.id, { [fd.name]: nv });
              this.editing = null;
            })}
          </td>`;
        }
        return html`<td title=${v == null ? '' : String(v)} @dblclick=${(e: Event) => (e.stopPropagation(), (this.editing = key))}>
          ${v === true ? 'Sí' : v === false ? 'No' : v == null ? '' : String(v)}
        </td>`;
      })}
    </tr>`;
  }

  protected override updated(): void {
    const input = this.renderRoot.querySelector<HTMLInputElement>('td input');
    if (input && document.activeElement !== input && !input.matches(':focus')) input.focus();
  }

  private zoomTo(f: Readonly<EditorFeature>) {
    const vs = f.geometry ? getVertices(f.geometry) : [];
    if (!vs.length) return;
    const xs = vs.map((v) => v.coord[0]!);
    const ys = vs.map((v) => v.coord[1]!);
    this.editor!.map.fitBounds([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], { padding: 80, maxZoom: 18, duration: 500 });
  }
}
