import { css, html } from 'lit';
import type { ToolId } from '@map-editor/core';
import { EditorConsumer } from '../base.js';
import { icons } from '../icons.js';
import { controls, theme } from '../styles.js';

const TOOLS: Array<{ id: ToolId; label: string; key: string; icon: keyof typeof icons; help: string }> = [
  { id: 'select', label: 'Seleccionar y editar vértices', key: 'V', icon: 'select', help: 'Clic: seleccionar · Mayús+clic: añadir · Mayús+arrastrar: rectángulo · Arrastrar vértice: mover · Alt+clic en vértice: borrar · Arrastrar punto medio: insertar vértice' },
  { id: 'draw-point', label: 'Dibujar punto', key: 'P', icon: 'point', help: 'Clic para añadir un punto' },
  { id: 'draw-line', label: 'Dibujar línea', key: 'L', icon: 'line', help: 'Clic: añadir vértice · Doble clic o Intro: terminar · Retroceso: quitar último · Esc: cancelar' },
  { id: 'draw-polygon', label: 'Dibujar polígono', key: 'G', icon: 'polygon', help: 'Clic: añadir vértice · Clic en el primero, doble clic o Intro: cerrar · Esc: cancelar' },
  { id: 'move', label: 'Mover entidades', key: 'M', icon: 'move', help: 'Arrastrar una entidad o la selección. El vértice más cercano al cursor se engancha.' },
];

export const TOOL_HELP = Object.fromEntries(TOOLS.map((t) => [t.id, t.help])) as Record<ToolId, string>;

/** Barra de herramientas de edición. */
export class MeToolbar extends EditorConsumer {
  static override styles = [
    theme,
    controls,
    css`
      :host {
        display: block;
      }
      .bar {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: 4px;
      }
      .sep {
        height: 1px;
        background: var(--me-border);
        margin: 4px 2px;
      }
      button[aria-pressed='true'] {
        background: var(--me-primary);
        color: var(--me-primary-contrast);
      }
      button.snap[aria-pressed='false'] {
        opacity: 0.6;
      }
      @media (max-width: 640px) {
        .bar {
          flex-direction: row;
          flex-wrap: nowrap;
          overflow-x: auto;
          scrollbar-width: none;
        }
        button.icon {
          padding: 8px;
          flex: none;
        }
        .sep {
          width: 1px;
          height: auto;
          margin: 2px 4px;
        }
      }
    `,
  ];

  constructor() {
    super();
    this.watch = ['tool-changed', 'history-changed', 'selection-changed', 'snap-config-changed'];
  }

  override render() {
    const ed = this.editor;
    if (!ed) return html``;
    const tool = ed.getTool();
    const snap = ed.getSnapConfig().enabled;
    const sel = ed.getSelection().length;
    return html`<div class="bar panel" role="toolbar" aria-label="Herramientas de edición">
      ${TOOLS.map(
        (t) => html`<button class="icon" title="${t.label} (${t.key})" aria-label=${t.label} aria-pressed=${tool === t.id} @click=${() => ed.setTool(t.id)}>
          ${icons[t.icon]}
        </button>`,
      )}
      <div class="sep"></div>
      <button class="icon" title="Borrar selección (Supr)" aria-label="Borrar selección" ?disabled=${!sel} @click=${() => ed.deleteSelected()}>${icons.trash}</button>
      <button class="icon" title="Deshacer (Ctrl+Z)" aria-label="Deshacer" ?disabled=${!ed.canUndo()} @click=${() => ed.undo()}>${icons.undo}</button>
      <button class="icon" title="Rehacer (Ctrl+Y)" aria-label="Rehacer" ?disabled=${!ed.canRedo()} @click=${() => ed.redo()}>${icons.redo}</button>
      <div class="sep"></div>
      <button class="icon snap" title="Snapping ${snap ? 'activado' : 'desactivado'} (S)" aria-label="Snapping" aria-pressed=${snap} @click=${() => ed.setSnapping(!snap)}>
        ${icons.magnet}
      </button>
      <button class="icon" title="Configurar snapping" aria-label="Configurar snapping" @click=${() => this.fire('me-open-snap-settings')}>${icons.settings}</button>
    </div>`;
  }
}
