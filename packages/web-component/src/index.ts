import { MeAttributePanel, MeAttributeTable } from './components/attributes.js';
import { MeExportDialog, MeSnapSettings } from './components/dialogs.js';
import { MeLayerPanel } from './components/layer-panel.js';
import { MeBasemapSwitcher, MeEditActions, MeStatusBar } from './components/misc.js';
import { MeToolbar } from './components/toolbar.js';
import { MapEditorElement } from './map-editor-element.js';

export { MapEditorElement, MeToolbar, MeLayerPanel, MeAttributePanel, MeAttributeTable, MeExportDialog, MeSnapSettings, MeBasemapSwitcher, MeStatusBar, MeEditActions };
export { EditorConsumer } from './base.js';
export * from '@map-editor/core';

const ELEMENTS: Record<string, CustomElementConstructor> = {
  'map-editor': MapEditorElement,
  'me-toolbar': MeToolbar,
  'me-layer-panel': MeLayerPanel,
  'me-attribute-panel': MeAttributePanel,
  'me-attribute-table': MeAttributeTable,
  'me-export-dialog': MeExportDialog,
  'me-snap-settings': MeSnapSettings,
  'me-basemap-switcher': MeBasemapSwitcher,
  'me-status-bar': MeStatusBar,
  'me-edit-actions': MeEditActions,
};

for (const [tag, ctor] of Object.entries(ELEMENTS)) {
  if (!customElements.get(tag)) customElements.define(tag, ctor);
}

declare global {
  interface HTMLElementTagNameMap {
    'map-editor': MapEditorElement;
    'me-toolbar': MeToolbar;
    'me-layer-panel': MeLayerPanel;
    'me-attribute-panel': MeAttributePanel;
    'me-attribute-table': MeAttributeTable;
    'me-export-dialog': MeExportDialog;
    'me-snap-settings': MeSnapSettings;
    'me-basemap-switcher': MeBasemapSwitcher;
    'me-status-bar': MeStatusBar;
    'me-edit-actions': MeEditActions;
  }
}
