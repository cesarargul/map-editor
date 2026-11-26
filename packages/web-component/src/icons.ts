import { svg, type TemplateResult } from 'lit';

const icon = (body: TemplateResult) =>
  svg`<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icons = {
  select: icon(svg`<path d="M5 3l14 8-6 2-3 6z"/>`),
  point: icon(svg`<circle cx="12" cy="10" r="3"/><path d="M12 21s-7-6.5-7-11a7 7 0 0 1 14 0c0 4.5-7 11-7 11z"/>`),
  line: icon(svg`<circle cx="5" cy="19" r="2"/><circle cx="12" cy="8" r="2"/><circle cx="19" cy="15" r="2"/><path d="M6.5 17.5l4-8M13.5 9.5l4 4"/>`),
  polygon: icon(svg`<path d="M12 3l8 6-3 11H7L4 9z"/>`),
  move: icon(svg`<path d="M12 2v20M2 12h20M12 2l-3 3M12 2l3 3M12 22l-3-3M12 22l3-3M2 12l3-3M2 12l3 3M22 12l-3-3M22 12l-3 3"/>`),
  trash: icon(svg`<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>`),
  undo: icon(svg`<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>`),
  redo: icon(svg`<path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>`),
  magnet: icon(svg`<path d="M6 3v8a6 6 0 0 0 12 0V3"/><path d="M6 7h4M14 7h4"/>`),
  settings: icon(svg`<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>`),
  layers: icon(svg`<path d="M12 2l10 5-10 5L2 7z"/><path d="M2 12l10 5 10-5M2 17l10 5 10-5"/>`),
  table: icon(svg`<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M3 9h18M3 14h18M9 4v16"/>`),
  map: icon(svg`<path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/>`),
  eye: icon(svg`<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>`),
  eyeOff: icon(svg`<path d="M17.9 17.9A10.5 10.5 0 0 1 12 19c-7 0-11-7-11-7a19 19 0 0 1 5-5.9M9.9 5.2A9.5 9.5 0 0 1 12 5c7 0 11 7 11 7a19 19 0 0 1-2.2 3.2M1 1l22 22"/>`),
  download: icon(svg`<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>`),
  upload: icon(svg`<path d="M12 21V9M7 14l5-5 5 5M5 3h14"/>`),
  zoom: icon(svg`<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M11 8v6M8 11h6"/>`),
  lock: icon(svg`<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>`),
  unlock: icon(svg`<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/>`),
  plus: icon(svg`<path d="M12 5v14M5 12h14"/>`),
  close: icon(svg`<path d="M6 6l12 12M18 6L6 18"/>`),
  up: icon(svg`<path d="M6 15l6-6 6 6"/>`),
  down: icon(svg`<path d="M6 9l6 6 6-6"/>`),
  info: icon(svg`<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>`),
};
