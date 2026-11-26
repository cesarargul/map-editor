import { LitElement } from 'lit';
import type { EditorEvents, MapEditor } from '@map-editor/core';

/**
 * Base para los componentes de interfaz: reciben el editor por propiedad,
 * se suscriben a los eventos indicados y se repintan cuando cambian.
 *
 * Nota: se usan `static properties` + `declare` (sin decoradores) para que el código
 * funcione igual con cualquier compilador (tsc, esbuild, oxc, Angular CLI).
 */
export abstract class EditorConsumer extends LitElement {
  static override properties = { editor: { attribute: false } };
  declare editor: MapEditor | null;

  /** Eventos del editor que provocan un repintado. */
  protected watch: Array<keyof EditorEvents> = [];
  private unsubs: Array<() => void> = [];
  private bound: MapEditor | null = null;

  constructor() {
    super();
    this.editor = null;
  }

  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (changed.has('editor') && this.editor !== this.bound) this.rebind();
  }

  override connectedCallback(): void {
    super.connectedCallback();
    if (this.editor && !this.bound) this.rebind();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unbind();
  }

  private rebind(): void {
    this.unbind();
    this.bound = this.editor;
    if (!this.editor) return;
    for (const ev of this.watch) this.unsubs.push(this.editor.on(ev, () => this.requestUpdate()));
    this.editorBound(this.editor);
  }

  private unbind(): void {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    this.bound = null;
  }

  /** Para suscripciones adicionales (registrar la baja con `this.track()`). */
  protected editorBound(_editor: MapEditor): void {}

  protected track(unsub: () => void): void {
    this.unsubs.push(unsub);
  }

  /** Emite un evento que atraviesa el shadow DOM. */
  protected fire<T>(name: string, detail?: T): void {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }
}
