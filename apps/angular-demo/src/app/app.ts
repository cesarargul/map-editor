import { Component, computed, signal, viewChild } from '@angular/core';
import { MapEditorComponent, type MapEditor } from '@map-editor/angular';

@Component({
  selector: 'app-root',
  imports: [MapEditorComponent],
  template: `
    <header>
      <strong>Map Editor en Angular</strong>
      <span>{{ layerCount() }} capas · {{ selectionCount() }} seleccionadas</span>
      <button (click)="createLayer()">Nueva capa de puntos</button>
    </header>
    <me-map-editor
      #mapEditor
      storageKey="angular-demo"
      [center]="[-3.7, 40.42]"
      [zoom]="12"
      (ready)="onReady($event)"
      (message)="lastMessage.set($event.text)"
    />
    <footer data-testid="last-message">{{ lastMessage() }}</footer>
  `,
  styles: [
    `
      :host { display: flex; flex-direction: column; height: 100vh; }
      header, footer { display: flex; gap: 12px; align-items: center; padding: 6px 12px; background: #1d2329; color: #fff; }
      me-map-editor { flex: 1; }
    `,
  ],
})
export class App {
  private readonly mapEditor = viewChild.required(MapEditorComponent);
  protected readonly lastMessage = signal('');
  protected readonly layerCount = computed(() => this.mapEditor().layers().length);
  protected readonly selectionCount = computed(() => this.mapEditor().selection().length);

  onReady(editor: MapEditor): void {
    (window as unknown as { editor: MapEditor }).editor = editor;
    document.body.dataset['ready'] = 'true';
  }

  createLayer(): void {
    this.mapEditor().editor()?.createLayer('Puntos de inspección', 'Point', { fields: [{ name: 'estado', type: 'string' }] });
  }
}
