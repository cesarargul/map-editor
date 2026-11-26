let counter = 0;

/** Identificador único corto, estable dentro de la sesión. */
export function uid(prefix = 'f'): string {
  counter = (counter + 1) % 0x7fffffff;
  const rnd = Math.floor(Math.random() * 0xffffffff).toString(36);
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${rnd}`;
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}
