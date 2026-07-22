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

export const ADSBFI_INTEGRATION_ID = "@prsgoo/integration-adsbfi";
export const RECORD_TYPE_FLIGHT_POSITION = "flight.position";

const BASE_URL = "https://opendata.adsb.fi/api/v2/aircraft";

export const adsbFiConfigSchema = z.object({
  boundingBox: z
    .object({
      minLat: z.number().min(-90).max(90),
      maxLat: z.number().min(-90).max(90),
      minLon: z.number().min(-180).max(180),
      maxLon: z.number().min(-180).max(180),
    })
    .optional(),
});

export type AdsbFiConfig = z.infer<typeof adsbFiConfigSchema>;

export interface FlightPositionData {
  icao24: string;
  callsign: string | null;
  latitude: number;
  longitude: number;
  altitudeM: number | null;
  speedKt: number | null;
  heading: number | null;
  onGround: boolean;
  lastContact: string;
}

interface AdsbFiAircraft {
  hex: string;
  flight?: string;
  lat?: number;
  lon?: number;
  alt_baro?: number | "ground";
  gs?: number;
  track?: number;
  seen_pos?: number;
  [key: string]: unknown;
}

interface AdsbFiResponse {
  ac: AdsbFiAircraft[];
  now: number;
  total: number;
}

export class AdsbFiIntegrationPlugin implements IntegrationPlugin<AdsbFiConfig> {
  readonly manifest: IntegrationPluginManifest = {
    id: ADSBFI_INTEGRATION_ID,
    name: "adsb.fi",
    version: "0.1.0-beta.1",
    kind: PluginKinds.INTEGRATION,
    operations: [
      {
        id: "fetch-flights",
        name: "Fetch Flights",
        recordType: RECORD_TYPE_FLIGHT_POSITION,
      },
    ],
    auth: { type: "none" },
    polling: {
      defaultIntervalMs: 30_000,
      minIntervalMs: 10_000,
    },
    rateLimit: {
      requestsPerMinute: 10,
      maxConcurrentRequests: 1,
    },
  };

  readonly configSchema = adsbFiConfigSchema;

  private config: AdsbFiConfig = {};

  configure(config: AdsbFiConfig): void {
    this.config = config;
  }

  async execute(
    operationId: string,
    context: RuntimeContext,
  ): Promise<ReadonlyArray<PulseRecord<FlightPositionData>>> {
    if (operationId !== "fetch-flights") {
      throw new Error(
        `Operation '${operationId}' is not supported by plugin '${this.manifest.id}'.`,
      );
    }

    const url = this.buildUrl();
    const response = await fetch(url, { signal: context.signal ?? null });

    if (response.status === 429) {
      throw new RateLimitError("adsb.fi rate limit reached.", 60_000);
    }

    if (!response.ok) {
      throw new TransientError(`adsb.fi API returned HTTP ${response.status}.`);
    }

    const data = (await response.json()) as AdsbFiResponse;
    const nowMs = data.now * 1000;

    return data.ac.flatMap((ac): PulseRecord<FlightPositionData>[] => {
      if (ac.lat === undefined || ac.lon === undefined) return [];

      const altBaro = ac.alt_baro;
      const onGround = altBaro === "ground";
      const altitudeM =
        altBaro === "ground"
          ? 0
          : typeof altBaro === "number"
            ? altBaro * 0.3048
            : null;

      const lastContact = new Date(
        nowMs - (ac.seen_pos ?? 0) * 1000,
      ).toISOString();

      return [
        {
          type: RECORD_TYPE_FLIGHT_POSITION,
          timestamp: context.now().toISOString(),
          source: ADSBFI_INTEGRATION_ID,
          entityKey: `icao24:${ac.hex}`,
          data: {
            icao24: ac.hex,
            callsign: (ac.flight ?? "").trim() || null,
            latitude: ac.lat,
            longitude: ac.lon,
            altitudeM,
            speedKt: ac.gs ?? null,
            heading: ac.track ?? null,
            onGround,
            lastContact,
          },
        },
      ];
    });
  }

  private buildUrl(): string {
    const bb = this.config.boundingBox;
    if (!bb) return BASE_URL;

    const params = new URLSearchParams({
      lat_min: String(bb.minLat),
      lat_max: String(bb.maxLat),
      lon_min: String(bb.minLon),
      lon_max: String(bb.maxLon),
    });

    return `${BASE_URL}?${params.toString()}`;
  }
}
