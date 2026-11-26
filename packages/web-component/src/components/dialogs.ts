import { css, html, nothing } from 'lit';
import type { ExportFormat, ExportScope, SnapConfig, SnapType } from '@map-editor/core';
import { ALL_SNAP_TYPES, EXPORT_FORMATS, KNOWN_CRS } from '@map-editor/core';
import { EditorConsumer } from '../base.js';
import { icons } from '../icons.js';
import { controls, theme } from '../styles.js';

const dialogStyles = css`
  :host {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    background: rgba(0, 0, 0, 0.35);
    z-index: 20;
    padding: 16px;
  }
  .dialog {
    width: min(560px, 100%);
    max-height: calc(100% - 32px);
    overflow: auto;
    padding: 16px;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
  }
  header h2 {
    font-size: 16px;
    margin: 0;
  }
  .grid {
    display: grid;
    grid-template-columns: 140px 1fr;
    gap: 8px 12px;
    align-items: center;
  }
  footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 16px;
  }
  .hint {
    font-size: 12px;
    margin: 4px 0 0;
  }
`;

const SNAP_LABEL: Record<SnapType, string> = {
  vertex: 'Vértice',
  endpoint: 'Extremo',
  edge: 'Arista',
  midpoint: 'Punto medio',
  intersection: 'Intersección',
};

/** Diálogo de exportación: formato, CRS y alcance (todo o solo cambios). */
export class MeExportDialog extends EditorConsumer {
  static override properties = { ...EditorConsumer.properties, layerId: { type: String }, busy: { state: true } };
  declare layerId: string;
  declare busy: boolean;
  static override styles = [theme, controls, dialogStyles];

  constructor() {
    super();
    this.layerId = '';
    this.busy = false;
  }

  override render() {
    const ed = this.editor;
    const layer = ed?.getLayer(this.layerId);
    if (!ed || !layer) return nothing;
    const ch = ed.store.changeSummary(layer.id);
    const original = layer.source.format === 'memory' ? 'geojson' : layer.source.format;
    const crsOptions = KNOWN_CRS.some((c) => c.code === layer.source.crs) ? KNOWN_CRS : [{ code: layer.source.crs, name: 'CRS original' }, ...KNOWN_CRS];
    return html`<div class="dialog panel" role="dialog" aria-modal="true" aria-label="Descargar capa" @keydown=${(e: KeyboardEvent) => e.key === 'Escape' && this.close()}>
      <header>
        <h2>Descargar «${layer.name}»</h2>
        <button class="icon" aria-label="Cerrar" @click=${this.close}>${icons.close}</button>
      </header>
      <div class="grid">
        <label for="fmt">Formato</label>
        <select id="fmt">
          ${EXPORT_FORMATS.map((f) => html`<option value=${f.id} ?selected=${f.id === original}>${f.name}${f.id === original ? ' (original)' : ''}</option>`)}
        </select>
        <label for="crs">Sistema de referencia</label>
        <select id="crs">
          ${crsOptions.map((c) => html`<option value=${c.code} ?selected=${c.code === layer.source.crs}>${c.code} · ${c.name}${c.code === layer.source.crs ? ' (original)' : ''}</option>`)}
        </select>
        <label for="scope">Contenido</label>
        <select id="scope">
          <option value="all">Capa completa (estado actual)</option>
          <option value="changes">Solo cambios (+${ch.new} ~${ch.modified} −${ch.deleted})</option>
        </select>
        <label for="name">Nombre del fichero</label>
        <input id="name" .value=${layer.source.fileName ?? layer.name} />
      </div>
      <p class="hint muted">
        ${layer.source.hasZ ? 'La capa es 3D: se conserva la Z. ' : ''}${layer.source.crsGuessed ? 'Atención: el CRS de origen se dedujo automáticamente. ' : ''}KML y GPX
        siempre se exportan en WGS84. «Solo cambios» añade el atributo <code>_cambio</code>.
      </p>
      <footer>
        <button class="outline" @click=${this.close}>Cancelar</button>
        <button class="primary" ?disabled=${this.busy} @click=${this.download}>${icons.download} ${this.busy ? 'Generando…' : 'Descargar'}</button>
      </footer>
    </div>`;
  }

  private close = () => this.fire('me-close-dialog');

  private download = async () => {
    const q = <T extends HTMLElement>(s: string) => this.renderRoot.querySelector<T>(s)!;
    this.busy = true;
    try {
      await this.editor!.downloadLayer(this.layerId, {
        format: q<HTMLSelectElement>('#fmt').value as ExportFormat,
        crs: q<HTMLSelectElement>('#crs').value,
        scope: q<HTMLSelectElement>('#scope').value as ExportScope,
        fileName: q<HTMLInputElement>('#name').value.trim() || 'capa',
      });
      this.close();
    } catch (err) {
      this.editor!.message('error', `No se pudo exportar: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.busy = false;
    }
  };
}

/** Configuración del snapping: tolerancia, tipos, matriz de capas y opciones 3D. */
export class MeSnapSettings extends EditorConsumer {
  static override properties = { ...EditorConsumer.properties, draft: { state: true } };
  declare draft: SnapConfig | null;
  static override styles = [
    theme,
    controls,
    dialogStyles,
    css`
      .dialog {
        width: min(760px, 100%);
      }
      fieldset {
        border: 1px solid var(--me-border);
        border-radius: 6px;
        margin: 12px 0 0;
        padding: 8px 12px;
      }
      legend {
        padding: 0 4px;
        color: var(--me-fg-muted);
      }
      .types {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
      }
      .matrix {
        overflow: auto;
      }
      table {
        border-collapse: collapse;
      }
      th,
      td {
        padding: 4px 6px;
        text-align: center;
        border-bottom: 1px solid var(--me-border);
      }
      th.row {
        text-align: left;
        font-weight: normal;
        white-space: nowrap;
      }
      thead th {
        font-weight: 600;
        font-size: 12px;
        max-width: 110px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    `,
  ];

  constructor() {
    super();
    this.draft = null;
  }

  protected override editorBound(): void {
    this.draft = this.editor!.getSnapConfig();
  }

  override render() {
    const ed = this.editor;
    const d = this.draft;
    if (!ed || !d) return nothing;
    const layers = ed.getLayers();
    const update = (patch: Partial<SnapConfig>) => (this.draft = { ...d, ...patch });
    const targetsOf = (id: string) => {
      const spec = d.rules[id] ?? d.defaultTargets;
      return new Set(spec.flatMap((t) => (t === '*' ? layers.map((l) => l.id) : t === 'self' ? [id] : [t])));
    };
    const toggle = (src: string, tgt: string, on: boolean) => {
      const set = targetsOf(src);
      if (on) set.add(tgt);
      else set.delete(tgt);
      update({ rules: { ...d.rules, [src]: [...set] } });
    };
    const typesOf = (id: string) => new Set(d.targets[id]?.types ?? d.defaultTypes);
    return html`<div class="dialog panel" role="dialog" aria-modal="true" aria-label="Configurar snapping" @keydown=${(e: KeyboardEvent) => e.key === 'Escape' && this.close()}>
      <header>
        <h2>Snapping</h2>
        <button class="icon" aria-label="Cerrar" @click=${this.close}>${icons.close}</button>
      </header>
      <div class="grid">
        <label for="en">Activado</label>
        <input id="en" type="checkbox" .checked=${d.enabled} @change=${(e: Event) => update({ enabled: (e.target as HTMLInputElement).checked })} />
        <label for="tol">Tolerancia</label>
        <span><input id="tol" type="range" min="2" max="30" .value=${String(d.tolerancePx)} @input=${(e: Event) => update({ tolerancePx: Number((e.target as HTMLInputElement).value) })} /> ${d.tolerancePx} px</span>
        <label for="vis">Solo capas visibles</label>
        <input id="vis" type="checkbox" .checked=${d.visibleOnly} @change=${(e: Event) => update({ visibleOnly: (e.target as HTMLInputElement).checked })} />
      </div>

      <fieldset>
        <legend>Tipos de snap por defecto</legend>
        <div class="types">
          ${ALL_SNAP_TYPES.map(
            (t) => html`<label
              ><input
                type="checkbox"
                .checked=${d.defaultTypes.includes(t)}
                @change=${(e: Event) => update({ defaultTypes: (e.target as HTMLInputElement).checked ? [...d.defaultTypes, t] : d.defaultTypes.filter((x) => x !== t) })}
              />
              ${SNAP_LABEL[t]}</label
            >`,
          )}
        </div>
      </fieldset>

      <fieldset>
        <legend>Entre qué capas (fila: capa que editas · columna: capa a la que se engancha)</legend>
        ${layers.length
          ? html`<div class="matrix">
              <table>
                <thead>
                  <tr>
                    <th></th>
                    ${layers.map((l) => html`<th title=${l.name}>${l.name}</th>`)}
                  </tr>
                </thead>
                <tbody>
                  ${layers.map((src) => {
                    const set = targetsOf(src.id);
                    return html`<tr>
                      <th class="row">${src.name}</th>
                      ${layers.map(
                        (tgt) => html`<td>
                          <input type="checkbox" aria-label="${src.name} → ${tgt.name}" .checked=${set.has(tgt.id)} @change=${(e: Event) => toggle(src.id, tgt.id, (e.target as HTMLInputElement).checked)} />
                        </td>`,
                      )}
                    </tr>`;
                  })}
                </tbody>
              </table>
            </div>`
          : html`<p class="muted">Carga o crea capas para configurar la matriz.</p>`}
      </fieldset>

      ${layers.length
        ? html`<fieldset>
            <legend>Tipos de snap permitidos hacia cada capa</legend>
            <div class="matrix">
              <table>
                <thead>
                  <tr>
                    <th></th>
                    ${ALL_SNAP_TYPES.map((t) => html`<th>${SNAP_LABEL[t]}</th>`)}
                  </tr>
                </thead>
                <tbody>
                  ${layers.map((l) => {
                    const ts = typesOf(l.id);
                    return html`<tr>
                      <th class="row">${l.name}</th>
                      ${ALL_SNAP_TYPES.map(
                        (t) => html`<td>
                          <input
                            type="checkbox"
                            aria-label="${l.name}: ${SNAP_LABEL[t]}"
                            .checked=${ts.has(t)}
                            @change=${(e: Event) => {
                              const next = new Set(ts);
                              if ((e.target as HTMLInputElement).checked) next.add(t);
                              else next.delete(t);
                              update({ targets: { ...d.targets, [l.id]: { ...d.targets[l.id], types: [...next] } } });
                            }}
                          />
                        </td>`,
                      )}
                    </tr>`;
                  })}
                </tbody>
              </table>
            </div>
          </fieldset>`
        : nothing}

      <fieldset>
        <legend>3D</legend>
        <div class="grid">
          <label for="iz">Heredar la Z</label>
          <input id="iz" type="checkbox" .checked=${d.inheritZ} @change=${(e: Event) => update({ inheritZ: (e.target as HTMLInputElement).checked })} />
          <label for="zt">Tolerancia Z</label>
          <span><input id="zt" type="number" step="0.001" min="0" .value=${String(d.zTolerance)} @change=${(e: Event) => update({ zTolerance: Number((e.target as HTMLInputElement).value) || 0 })} /> unidades del dato</span>
        </div>
        <p class="hint muted">Dos elementos que se cruzan en planta solo se consideran conectados si su Z coincide dentro de la tolerancia. Los cruces sin conexión se marcan en rojo al acercar el cursor.</p>
      </fieldset>

      <footer>
        <button class="outline" @click=${() => (this.draft = this.editor!.getSnapConfig())}>Descartar cambios</button>
        <button class="primary" @click=${this.apply}>Aplicar</button>
      </footer>
    </div>`;
  }

  private close = () => this.fire('me-close-dialog');

  private apply = () => {
    if (this.draft) this.editor!.setSnapConfig(this.draft);
    this.fire('me-snap-config-applied', this.draft);
    this.close();
  };
}
