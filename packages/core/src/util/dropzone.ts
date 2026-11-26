export interface DropZoneOptions {
  onFiles(files: File[]): void;
  onDragStateChange?(active: boolean): void;
}

/**
 * Convierte un elemento en zona de arrastrar y soltar ficheros.
 * Admite carpetas (p. ej. una carpeta con los componentes de un Shapefile).
 * Devuelve una función para desinstalarla.
 */
export function installDropZone(el: HTMLElement, opts: DropZoneOptions): () => void {
  let depth = 0;
  const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');

  const onEnter = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (depth++ === 0) opts.onDragStateChange?.(true);
  };
  const onOver = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  };
  const onLeave = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    if (--depth <= 0) {
      depth = 0;
      opts.onDragStateChange?.(false);
    }
  };
  const onDrop = async (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    opts.onDragStateChange?.(false);
    const files = await filesFromDataTransfer(e.dataTransfer!);
    if (files.length) opts.onFiles(files);
  };

  el.addEventListener('dragenter', onEnter);
  el.addEventListener('dragover', onOver);
  el.addEventListener('dragleave', onLeave);
  el.addEventListener('drop', onDrop);
  return () => {
    el.removeEventListener('dragenter', onEnter);
    el.removeEventListener('dragover', onOver);
    el.removeEventListener('dragleave', onLeave);
    el.removeEventListener('drop', onDrop);
  };
}

interface Entry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath: string;
  file?(cb: (f: File) => void, err: (e: unknown) => void): void;
  createReader?(): { readEntries(cb: (entries: Entry[]) => void, err: (e: unknown) => void): void };
}

export async function filesFromDataTransfer(dt: DataTransfer): Promise<File[]> {
  const items = [...(dt.items ?? [])];
  const entries = items
    .map((i) => (i.webkitGetAsEntry?.() ?? null) as unknown as Entry | null)
    .filter((e): e is Entry => e !== null);
  if (!entries.length || !entries.some((e) => e.isDirectory)) return [...dt.files];
  const out: File[] = [];
  for (const entry of entries) await walk(entry, out);
  return out;
}

async function walk(entry: Entry, out: File[]): Promise<void> {
  if (entry.isFile && entry.file) {
    const file = await new Promise<File>((res, rej) => entry.file!(res, rej));
    out.push(new File([file], entry.fullPath.replace(/^\//, ''), { type: file.type }));
  } else if (entry.isDirectory && entry.createReader) {
    const reader = entry.createReader();
    let batch: Entry[];
    do {
      batch = await new Promise<Entry[]>((res, rej) => reader.readEntries(res, rej));
      for (const child of batch) await walk(child, out);
    } while (batch.length);
  }
}

/** Descarga un fichero en el navegador. */
export function downloadBlob(data: Uint8Array | Blob, fileName: string, mimeType = 'application/octet-stream'): void {
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
