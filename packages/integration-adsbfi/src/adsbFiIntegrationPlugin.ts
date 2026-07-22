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

const BASE_URL = "https://opendata.adsb.fi/api/v2";

export const adsbFiConfigSchema = z.object({
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
  dist: z.number().positive().optional(),
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
  aircraft: AdsbFiAircraft[];
  now: number;
}

export class AdsbFiIntegrationPlugin implements IntegrationPlugin<AdsbFiConfig> {
  readonly manifest: IntegrationPluginManifest = {
    id: ADSBFI_INTEGRATION_ID,
    name: "adsb.fi",
    version: "0.1.0-beta.2",
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

    return data.aircraft.flatMap((ac): PulseRecord<FlightPositionData>[] => {
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
    const { lat, lon, dist } = this.config;
    if (lat === undefined || lon === undefined || dist === undefined) {
      throw new Error("adsb.fi requires lat, lon, and dist to be configured.");
    }
    return `${BASE_URL}/lat/${lat}/lon/${lon}/dist/${dist}`;
  }
}
