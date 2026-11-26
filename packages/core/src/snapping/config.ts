export type SnapType = 'vertex' | 'endpoint' | 'edge' | 'midpoint' | 'intersection';

export const ALL_SNAP_TYPES: SnapType[] = ['vertex', 'endpoint', 'edge', 'midpoint', 'intersection'];

export interface SnapTargetOptions {
  /** Tipos de snap permitidos hacia esta capa (por defecto, `defaultTypes`). */
  types?: SnapType[];
  /** Tolerancia propia en píxeles. */
  tolerancePx?: number;
  /** Prioridad: mayor gana en caso de empate de distancia. */
  priority?: number;
}

/**
 * Configuración de snapping. Es JSON serializable para poder guardarla o pasarla como input.
 *
 * La matriz `rules` define, para cada capa que se edita, a qué capas se puede enganchar:
 * - `'*'`: todas las capas visibles
 * - `'self'`: la propia capa
 * - un id de capa concreto
 *
 * Si una capa no aparece en `rules`, se usa `defaultTargets`.
 */
export interface SnapConfig {
  enabled: boolean;
  tolerancePx: number;
  defaultTypes: SnapType[];
  defaultTargets: string[];
  rules: Record<string, string[]>;
  targets: Record<string, SnapTargetOptions>;
  /** Heredar la Z del elemento al que se engancha (vértice) o interpolarla (arista). */
  inheritZ: boolean;
  /** Tolerancia en Z (unidades del dato, normalmente metros) para considerar dos puntos conectados en 3D. */
  zTolerance: number;
  /** Solo enganchar a capas visibles. */
  visibleOnly: boolean;
}

export const DEFAULT_SNAP_CONFIG: SnapConfig = {
  enabled: true,
  tolerancePx: 12,
  defaultTypes: ['vertex', 'endpoint', 'edge', 'midpoint', 'intersection'],
  defaultTargets: ['*'],
  rules: {},
  targets: {},
  inheritZ: true,
  zTolerance: 0.01,
  visibleOnly: true,
};

export function normalizeSnapConfig(cfg: Partial<SnapConfig> | undefined): SnapConfig {
  return {
    ...DEFAULT_SNAP_CONFIG,
    ...cfg,
    defaultTypes: cfg?.defaultTypes ?? [...DEFAULT_SNAP_CONFIG.defaultTypes],
    defaultTargets: cfg?.defaultTargets ?? [...DEFAULT_SNAP_CONFIG.defaultTargets],
    rules: { ...(cfg?.rules ?? {}) },
    targets: { ...(cfg?.targets ?? {}) },
  };
}

/** Capas destino de snapping para la capa que se está editando. */
export function resolveTargets(cfg: SnapConfig, editingLayerId: string | null, allLayerIds: string[]): string[] {
  const spec = (editingLayerId && cfg.rules[editingLayerId]) || cfg.defaultTargets;
  const out = new Set<string>();
  for (const t of spec) {
    if (t === '*') allLayerIds.forEach((id) => out.add(id));
    else if (t === 'self') {
      if (editingLayerId) out.add(editingLayerId);
    } else if (allLayerIds.includes(t)) out.add(t);
  }
  return [...out];
}

export function targetTypes(cfg: SnapConfig, layerId: string): SnapType[] {
  return cfg.targets[layerId]?.types ?? cfg.defaultTypes;
}
