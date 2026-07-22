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

export const AIRPLANES_LIVE_INTEGRATION_ID =
  "@prsgoo/integration-airplaneslive";
export const RECORD_TYPE_FLIGHT_POSITION = "flight.position";

const BASE_URL = "https://api.airplanes.live/v2/point";

export const airplanesLiveConfigSchema = z.object({
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
  radius: z.number().positive().optional(),
});

export type AirplanesLiveConfig = z.infer<typeof airplanesLiveConfigSchema>;

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

interface AirplanesLiveAircraft {
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

interface AirplanesLiveResponse {
  ac: AirplanesLiveAircraft[];
  now: number;
  total: number;
}

export class AirplanesLiveIntegrationPlugin implements IntegrationPlugin<AirplanesLiveConfig> {
  readonly manifest: IntegrationPluginManifest = {
    id: AIRPLANES_LIVE_INTEGRATION_ID,
    name: "Airplanes.live",
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

  readonly configSchema = airplanesLiveConfigSchema;

  private config: AirplanesLiveConfig = {};

  configure(config: AirplanesLiveConfig): void {
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
      throw new RateLimitError("Airplanes.live rate limit reached.", 60_000);
    }

    if (!response.ok) {
      throw new TransientError(
        `Airplanes.live API returned HTTP ${response.status}.`,
      );
    }

    const data = (await response.json()) as AirplanesLiveResponse;
    const nowMs = data.now * 1000;

    return data.ac.flatMap((ac) => {
      if (ac.lat == null || ac.lon == null) return [];

      let altitudeM: number | null;
      let onGround: boolean;

      if (ac.alt_baro === "ground") {
        altitudeM = 0;
        onGround = true;
      } else if (typeof ac.alt_baro === "number") {
        altitudeM = ac.alt_baro * 0.3048;
        onGround = false;
      } else {
        altitudeM = null;
        onGround = false;
      }

      const lastContact = new Date(
        nowMs - (ac.seen_pos ?? 0) * 1000,
      ).toISOString();

      return [
        {
          type: RECORD_TYPE_FLIGHT_POSITION,
          timestamp: context.now().toISOString(),
          source: AIRPLANES_LIVE_INTEGRATION_ID,
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
    const { lat, lon, radius } = this.config;
    if (lat === undefined || lon === undefined || radius === undefined) {
      throw new Error(
        "Airplanes.live requires lat, lon, and radius to be configured.",
      );
    }
    return `${BASE_URL}/${lat}/${lon}/${radius}`;
  }
}
