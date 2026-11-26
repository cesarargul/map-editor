import type { FeatureCollection } from 'geojson';
import type { InputFile, IoConfig } from './types.js';
import { toBytes } from './types.js';

/**
 * Acceso perezoso a GDAL-WASM (gdal3.js). Solo se descarga (~10 MB) la primera vez que se
 * necesita un formato que no cubren los lectores ligeros (DXF, GML, MapInfo, DGN, CSV…).
 */

interface GdalFile {
  name?: string;
  local?: string;
  real?: string;
  all?: Array<{ local: string; real: string }>;
}
interface GdalDataset {
  pointer: number;
  path: string;
  type: string;
  info?: { featureCount?: number; layers?: Array<{ name: string }> };
}
interface GdalApi {
  open(files: File | File[] | string | string[]): Promise<{ datasets: GdalDataset[]; errors: string[] }>;
  ogr2ogr(dataset: GdalDataset, options: string[], outputName?: string): Promise<GdalFile>;
  getFileBytes(file: GdalFile | string): Promise<Uint8Array>;
  getInfo(dataset: GdalDataset): Promise<{ layers?: Array<{ name: string; geometryFields?: Array<{ coordinateSystem?: { wkt?: string; projjson?: { id?: { authority: string; code: number } } } }> }> }>;
  close(dataset: GdalDataset): Promise<void>;
}

let gdalPromise: Promise<GdalApi> | null = null;

export const GDAL_EXTENSIONS = ['dxf', 'gml', 'tab', 'mif', 'dgn', 'csv', 'xlsx', 'ods', 'gpx', 'kml', 'sqlite', 'gdb', 'json'];

export const GDAL_WRITE_DRIVERS: Record<string, { driver: string; ext: string; mime: string }> = {
  dxf: { driver: 'DXF', ext: 'dxf', mime: 'image/vnd.dxf' },
  gml: { driver: 'GML', ext: 'gml', mime: 'application/gml+xml' },
  csv: { driver: 'CSV', ext: 'csv', mime: 'text/csv' },
};

async function loadGdal(config?: IoConfig): Promise<GdalApi> {
  if (config?.gdal?.enabled === false) throw new Error('GDAL está desactivado en la configuración.');
  if (!gdalPromise) {
    const path = config?.gdal?.path ?? 'https://cdn.jsdelivr.net/npm/gdal3.js@2.8.1/dist/package';
    gdalPromise = import(/* @vite-ignore */ 'gdal3.js')
      .then((m) => {
        const init = (m as unknown as { default: (o: object) => Promise<GdalApi> }).default;
        return init({ path, useWorker: false });
      })
      .catch((err) => {
        gdalPromise = null;
        throw new Error(`No se pudo cargar GDAL-WASM: ${err instanceof Error ? err.message : err}`);
      });
  }
  return gdalPromise;
}

/** Lee cualquier formato vectorial soportado por GDAL y lo devuelve como GeoJSON en su CRS original. */
export async function readWithGdal(
  files: InputFile[],
  config?: IoConfig,
): Promise<Array<{ name: string; collection: FeatureCollection; crs: string | null; crsWkt: string | null }>> {
  const Gdal = await loadGdal(config);
  const fileObjs = files.map((f) => new File([toBytes(f.data) as BlobPart], f.name));
  const { datasets, errors } = await Gdal.open(fileObjs);
  if (!datasets.length) throw new Error(`GDAL no pudo abrir el fichero: ${errors.join('; ')}`);
  const out = [];
  for (const ds of datasets) {
    const info = await Gdal.getInfo(ds).catch(() => ({ layers: [] as never[] }));
    const layers = info.layers?.length ? info.layers : [{ name: ds.path, geometryFields: [] }];
    for (const layer of layers) {
      const cs = layer.geometryFields?.[0]?.coordinateSystem;
      const id = cs?.projjson?.id;
      const crs = id ? `${id.authority}:${id.code}` : null;
      const res = await Gdal.ogr2ogr(ds, ['-f', 'GeoJSON', '-lco', 'RFC7946=NO', '-lco', 'WRITE_BBOX=NO', layer.name], `${layer.name}.geojson`);
      const bytes = await Gdal.getFileBytes(res);
      const collection = JSON.parse(new TextDecoder().decode(bytes)) as FeatureCollection;
      out.push({ name: layer.name, collection, crs, crsWkt: cs?.wkt ?? null });
    }
    await Gdal.close(ds);
  }
  return out;
}

/** Convierte un GeoJSON (en el CRS indicado) a otro formato con GDAL. */
export async function writeWithGdal(geojson: string, crs: string, format: string, baseName: string, config?: IoConfig): Promise<{ data: Uint8Array; ext: string; mime: string }> {
  const drv = GDAL_WRITE_DRIVERS[format];
  if (!drv) throw new Error(`Formato de salida no soportado por GDAL: ${format}`);
  const Gdal = await loadGdal(config);
  const { datasets, errors } = await Gdal.open(new File([geojson], `${baseName}.geojson`));
  const ds = datasets[0];
  if (!ds) throw new Error(`GDAL no pudo abrir el GeoJSON temporal: ${errors.join('; ')}`);
  try {
    const res = await Gdal.ogr2ogr(ds, ['-f', drv.driver, '-a_srs', crs], `${baseName}.${drv.ext}`);
    return { data: await Gdal.getFileBytes(res), ext: drv.ext, mime: drv.mime };
  } finally {
    await Gdal.close(ds);
  }
}
