import { bootstrapApplication } from '@angular/platform-browser';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideMapEditor } from '@map-editor/angular';
import { App } from './app/app';

bootstrapApplication(App, {
  providers: [
    provideZonelessChangeDetection(),
    // Ficheros copiados por la sección "assets" de angular.json
    provideMapEditor({ workerUrl: '/maplibre/maplibre-gl-worker.mjs', sqlWasmUrl: '/sqljs/sql-wasm.wasm' }),
  ],
}).catch((err) => console.error(err));
