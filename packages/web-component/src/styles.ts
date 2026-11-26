import { css } from 'lit';

/** Variables de tema. Se pueden sobrescribir desde fuera: map-editor { --me-primary: … } */
export const theme = css`
  :host {
    --me-primary: #1f6feb;
    --me-primary-contrast: #ffffff;
    --me-bg: #ffffff;
    --me-bg-alt: #f4f6f8;
    --me-fg: #1d2329;
    --me-fg-muted: #5b6670;
    --me-border: #d5dbe1;
    --me-shadow: 0 2px 10px rgba(0, 0, 0, 0.18);
    --me-radius: 8px;
    --me-new: #2ecc71;
    --me-modified: #ff7f0e;
    --me-deleted: #e74c3c;
    --me-font: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    font-family: var(--me-font);
    font-size: 13px;
    color: var(--me-fg);
  }
  @media (prefers-color-scheme: dark) {
    :host(:not([theme='light'])) {
      --me-bg: #1e2329;
      --me-bg-alt: #2a3038;
      --me-fg: #e6e9ec;
      --me-fg-muted: #9aa5b0;
      --me-border: #3a424c;
      --me-shadow: 0 2px 12px rgba(0, 0, 0, 0.5);
    }
  }
  :host([theme='dark']) {
    --me-bg: #1e2329;
    --me-bg-alt: #2a3038;
    --me-fg: #e6e9ec;
    --me-fg-muted: #9aa5b0;
    --me-border: #3a424c;
    --me-shadow: 0 2px 12px rgba(0, 0, 0, 0.5);
  }
`;

export const controls = css`
  * {
    box-sizing: border-box;
  }
  button {
    font: inherit;
    color: inherit;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 6px;
    padding: 4px 8px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  button:hover:not(:disabled) {
    background: var(--me-bg-alt);
  }
  button:focus-visible,
  input:focus-visible,
  select:focus-visible {
    outline: 2px solid var(--me-primary);
    outline-offset: 1px;
  }
  button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  button.primary {
    background: var(--me-primary);
    color: var(--me-primary-contrast);
  }
  button.primary:hover:not(:disabled) {
    background: var(--me-primary);
    filter: brightness(1.1);
  }
  button.outline {
    border-color: var(--me-border);
  }
  button.icon {
    padding: 6px;
  }
  input,
  select,
  textarea {
    font: inherit;
    color: inherit;
    background: var(--me-bg);
    border: 1px solid var(--me-border);
    border-radius: 6px;
    padding: 4px 6px;
    min-width: 0;
  }
  input[type='checkbox'] {
    accent-color: var(--me-primary);
  }
  .panel {
    background: var(--me-bg);
    color: var(--me-fg);
    border-radius: var(--me-radius);
    box-shadow: var(--me-shadow);
  }
  .muted {
    color: var(--me-fg-muted);
  }
  h3 {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--me-fg-muted);
    margin: 0;
  }
  .badge {
    display: inline-block;
    padding: 0 5px;
    border-radius: 9px;
    font-size: 11px;
    line-height: 16px;
    color: #fff;
  }
  .badge.new {
    background: var(--me-new);
  }
  .badge.modified {
    background: var(--me-modified);
  }
  .badge.deleted {
    background: var(--me-deleted);
  }
`;
