import { z } from "zod";
import {
  PluginKinds,
  PluginAuthError,
  RateLimitError,
  TransientError,
  type IntegrationPlugin,
  type IntegrationPluginManifest,
  type PulseRecord,
  type RuntimeContext,
} from "pulsebridge";

export const OPENAQ_INTEGRATION_ID = "@prsgoo/integration-openaq-air";
export const RECORD_TYPE_AIR_QUALITY = "air.quality";

const OPENAQ_BASE_URL = "https://api.openaq.org/v3";

export const openaqConfigSchema = z.object({
  locations: z.array(z.number().int().positive()).min(1),
});

export type OpenaqConfig = z.infer<typeof openaqConfigSchema>;

export interface AirQualityData {
  locationId: number;
  locationName: string;
  /** e.g. "pm25", "pm10", "o3", "no2", "co", "so2" */
  parameter: string;
  value: number;
  unit: string;
  latitude?: number;
  longitude?: number;
  country?: string;
}

interface OpenaqSensor {
  id: number;
  parameter: {
    name: string;
    units: string;
  };
}

interface OpenaqLocation {
  id: number;
  name: string;
  coordinates?: {
    latitude: number;
    longitude: number;
  };
  country?: {
    code: string;
  };
  sensors: OpenaqSensor[];
}

interface OpenaqLocationResponse {
  results: OpenaqLocation[];
}

interface OpenaqLatestValue {
  value: number;
  sensorsId: number;
  datetime: {
    utc: string;
  };
}

interface OpenaqLatestResponse {
  results: OpenaqLatestValue[];
}

export class OpenaqAirIntegrationPlugin implements IntegrationPlugin<OpenaqConfig> {
  readonly manifest: IntegrationPluginManifest = {
    id: OPENAQ_INTEGRATION_ID,
    name: "OpenAQ Air Quality",
    version: "0.1.0",
    kind: PluginKinds.INTEGRATION,
    operations: [
      {
        id: "fetch-measurements",
        name: "Fetch Measurements",
        recordType: RECORD_TYPE_AIR_QUALITY,
      },
    ],
    auth: {
      type: "apiKey",
      secrets: [{ key: "OPENAQ_API_KEY", required: true }],
    },
    polling: {
      defaultIntervalMs: 30 * 60_000,
      minIntervalMs: 10 * 60_000,
      hard: false,
    },
    rateLimit: {
      requestsPerMinute: 60,
      maxConcurrentRequests: 1,
    },
  };

  readonly configSchema = openaqConfigSchema;

  private config: OpenaqConfig = { locations: [] };

  configure(config: OpenaqConfig): void {
    this.config = config;
  }

  async execute(
    operationId: string,
    context: RuntimeContext,
  ): Promise<ReadonlyArray<PulseRecord<AirQualityData>>> {
    if (operationId !== "fetch-measurements") {
      throw new Error(
        `Operation '${operationId}' is not supported by plugin '${this.manifest.id}'.`,
      );
    }

    const apiKey = context.secrets.get("OPENAQ_API_KEY");
    if (!apiKey) {
      throw new PluginAuthError(
        "OPENAQ_API_KEY secret is required but not set.",
      );
    }

    const records: PulseRecord<AirQualityData>[] = [];
    const now = context.now().toISOString();

    for (const locationId of this.config.locations) {
      const metadata = await this.fetchJson<OpenaqLocationResponse>(
        `${OPENAQ_BASE_URL}/locations/${locationId}`,
        apiKey,
        context,
      );
      const location = metadata.results[0];
      if (!location) continue;

      const sensorsById = new Map<number, OpenaqSensor>(
        location.sensors.map((sensor) => [sensor.id, sensor]),
      );

      const latest = await this.fetchJson<OpenaqLatestResponse>(
        `${OPENAQ_BASE_URL}/locations/${locationId}/latest`,
        apiKey,
        context,
      );

      for (const measurement of latest.results) {
        const sensor = sensorsById.get(measurement.sensorsId);
        if (!sensor) continue;

        records.push({
          type: RECORD_TYPE_AIR_QUALITY,
          timestamp: now,
          source: OPENAQ_INTEGRATION_ID,
          entityKey: `openaq:${locationId}:${sensor.parameter.name}`,
          data: {
            locationId,
            locationName: location.name,
            parameter: sensor.parameter.name,
            value: measurement.value,
            unit: sensor.parameter.units,
            ...(location.coordinates !== undefined
              ? {
                  latitude: location.coordinates.latitude,
                  longitude: location.coordinates.longitude,
                }
              : {}),
            ...(location.country !== undefined
              ? { country: location.country.code }
              : {}),
          },
        });
      }
    }

    return records;
  }

  private async fetchJson<T>(
    url: string,
    apiKey: string,
    context: RuntimeContext,
  ): Promise<T> {
    const response = await fetch(url, {
      headers: { "X-API-Key": apiKey },
      signal: context.signal ?? null,
    });

    if (response.status === 401 || response.status === 403) {
      throw new PluginAuthError("OpenAQ API key is invalid.");
    }
    if (response.status === 429) {
      throw new RateLimitError("OpenAQ rate limit reached.", 60_000);
    }
    if (!response.ok) {
      throw new TransientError(`OpenAQ API returned HTTP ${response.status}.`);
    }

    return (await response.json()) as T;
  }
}
