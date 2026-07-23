import { z } from "zod";
import {
  PluginKinds,
  RateLimitError,
  TransientError,
  type IntegrationPlugin,
  type IntegrationPluginManifest,
  type PulseRecord,
  type RuntimeContext,
} from "pulsebridge";

export const NASA_FIRMS_INTEGRATION_ID = "@prsgoo/integration-nasa-firms";
export const RECORD_TYPE_WILDFIRE_EVENT = "wildfire.event";

const FIRMS_API_BASE = "https://firms.modaps.eosdis.nasa.gov/api/area/csv";
const WORLD_BBOX = "-180,-90,180,90";

export const nasaFirmsConfigSchema = z.object({
  boundingBox: z
    .object({
      minLat: z.number().min(-90).max(90),
      maxLat: z.number().min(-90).max(90),
      minLon: z.number().min(-180).max(180),
      maxLon: z.number().min(-180).max(180),
    })
    .optional(),
  dayRange: z.number().int().min(1).max(10).default(1),
  source: z
    .enum(["MODIS_NRT", "VIIRS_NOAA20_NRT", "VIIRS_SNPP_NRT"])
    .default("VIIRS_SNPP_NRT"),
});

export type NasaFirmsConfig = z.infer<typeof nasaFirmsConfigSchema>;

export interface WildfireEventData {
  latitude: number;
  longitude: number;
  brightness: number;
  frp: number;
  confidence: string;
  instrument: string;
  acquisitionDate: string;
  acquisitionTime: string;
  satellite: string;
}

function padTime(acqTime: string): string {
  return acqTime.padStart(4, "0");
}

function parseCsv(
  csv: string,
  now: string,
): ReadonlyArray<PulseRecord<WildfireEventData>> {
  const lines = csv.trim().split("\n");
  if (lines.length < 2) return [];

  const header = (lines[0] ?? "").split(",").map((h) => h.trim());
  const idx = (col: string) => header.indexOf(col);

  const latIdx = idx("latitude");
  const lonIdx = idx("longitude");
  const brightnessIdx =
    idx("bright_ti4") !== -1 ? idx("bright_ti4") : idx("brightness");
  const frpIdx = idx("frp");
  const confidenceIdx = idx("confidence");
  const instrumentIdx = idx("instrument");
  const acqDateIdx = idx("acq_date");
  const acqTimeIdx = idx("acq_time");
  const satelliteIdx = idx("satellite");

  const records: PulseRecord<WildfireEventData>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = (lines[i] ?? "").split(",").map((c) => c.trim());
    if (cols.length < header.length) continue;

    const latitude = parseFloat(cols[latIdx] ?? "");
    const longitude = parseFloat(cols[lonIdx] ?? "");

    if (isNaN(latitude) || isNaN(longitude)) continue;

    const acqDate = cols[acqDateIdx] ?? "";
    const acqTimePadded = padTime(cols[acqTimeIdx] ?? "");

    records.push({
      type: RECORD_TYPE_WILDFIRE_EVENT,
      timestamp: now,
      source: NASA_FIRMS_INTEGRATION_ID,
      entityKey: `firms:${latitude},${longitude},${acqDate},${acqTimePadded}`,
      data: {
        latitude,
        longitude,
        brightness: parseFloat(cols[brightnessIdx] ?? ""),
        frp: parseFloat(cols[frpIdx] ?? ""),
        confidence: cols[confidenceIdx] ?? "",
        instrument: cols[instrumentIdx] ?? "",
        acquisitionDate: acqDate,
        acquisitionTime: acqTimePadded,
        satellite: cols[satelliteIdx] ?? "",
      },
    });
  }

  return records;
}

export class NasaFirmsIntegrationPlugin implements IntegrationPlugin<NasaFirmsConfig> {
  readonly manifest: IntegrationPluginManifest = {
    id: NASA_FIRMS_INTEGRATION_ID,
    name: "NASA FIRMS",
    version: "0.1.0-beta.1",
    kind: PluginKinds.INTEGRATION,
    operations: [
      {
        id: "fetch-fires",
        name: "Fetch Fires",
        recordType: RECORD_TYPE_WILDFIRE_EVENT,
      },
    ],
    auth: {
      type: "apiKey",
      secrets: [{ key: "FIRMS_MAP_KEY", required: true }],
    },
    polling: {
      defaultIntervalMs: 3_600_000,
      minIntervalMs: 1_800_000,
    },
    rateLimit: {
      requestsPerMinute: 10,
      maxConcurrentRequests: 1,
    },
  };

  readonly configSchema = nasaFirmsConfigSchema;

  private config: NasaFirmsConfig = nasaFirmsConfigSchema.parse({});

  configure(config: NasaFirmsConfig): void {
    this.config = config;
  }

  async execute(
    operationId: string,
    context: RuntimeContext,
  ): Promise<ReadonlyArray<PulseRecord<WildfireEventData>>> {
    if (operationId !== "fetch-fires") {
      throw new Error(
        `Operation '${operationId}' is not supported by plugin '${this.manifest.id}'.`,
      );
    }

    const mapKey = context.secrets.get("FIRMS_MAP_KEY");
    if (!mapKey) {
      throw new TransientError("FIRMS_MAP_KEY secret is not configured.");
    }

    const url = this.buildUrl(mapKey);
    const response = await fetch(url, { signal: context.signal ?? null });

    if (response.status === 429) {
      throw new RateLimitError("NASA FIRMS rate limit reached.", 60_000);
    }

    if (!response.ok) {
      throw new TransientError(
        `NASA FIRMS API returned HTTP ${response.status}.`,
      );
    }

    const csv = await response.text();
    return parseCsv(csv, context.now().toISOString());
  }

  private buildUrl(mapKey: string): string {
    const { source, dayRange, boundingBox } = this.config;
    const bbox = boundingBox
      ? `${boundingBox.minLon},${boundingBox.minLat},${boundingBox.maxLon},${boundingBox.maxLat}`
      : WORLD_BBOX;
    return `${FIRMS_API_BASE}/${mapKey}/${source}/${bbox}/${dayRange}`;
  }
}
