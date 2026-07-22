import {
  PluginKinds,
  type ProcessorPlugin,
  type ProcessorPluginManifest,
  type PulseRecord,
  type PulseViewRecord,
  type RuntimeContext,
} from "pulsebridge";

export const FLIGHT_FEED_PROCESSOR_ID = "@prsgoo/processor-flight-feed";
export const RECORD_TYPE_FLIGHT_POSITION = "flight.position";
export const VIEW_FLIGHT_FEED = "flight-feed";

export interface FlightFeedItem {
  /** The record's entityKey — `icao24:<hex>` */
  id: string;
  icao24: string;
  callsign: string | null;
  latitude: number;
  longitude: number;
  altitudeM: number | null;
  speedKt: number | null;
  heading: number | null;
  onGround: boolean;
  /** The integration plugin id that produced this record */
  source: string;
  /** ISO timestamp of last update */
  updatedAt: string;
}

interface FlightPositionData {
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

export class FlightFeedProcessorPlugin implements ProcessorPlugin {
  readonly manifest: ProcessorPluginManifest = {
    id: FLIGHT_FEED_PROCESSOR_ID,
    name: "Flight Feed",
    version: "0.1.0",
    kind: PluginKinds.PROCESSOR,
    consumes: [RECORD_TYPE_FLIGHT_POSITION],
    produces: [VIEW_FLIGHT_FEED],
  };

  async process(
    records: ReadonlyArray<PulseRecord>,
    context: RuntimeContext,
  ): Promise<PulseViewRecord<FlightFeedItem> | null> {
    const flightRecords = records.filter(
      (r) => r.type === RECORD_TYPE_FLIGHT_POSITION,
    ) as ReadonlyArray<PulseRecord<FlightPositionData>>;

    if (flightRecords.length === 0) {
      context.logger.debug("No flight records to process.", {
        pluginId: FLIGHT_FEED_PROCESSOR_ID,
      });
      return null;
    }

    const latestByKey = new Map<string, PulseRecord<FlightPositionData>>();
    for (const record of flightRecords) {
      const key = record.entityKey;
      if (!key) continue;
      const existing = latestByKey.get(key);
      if (!existing || record.timestamp > existing.timestamp) {
        latestByKey.set(key, record);
      }
    }

    const items: FlightFeedItem[] = Array.from(latestByKey.entries())
      .map(([id, r]) => ({
        id,
        icao24: r.data.icao24,
        callsign: r.data.callsign,
        latitude: r.data.latitude,
        longitude: r.data.longitude,
        altitudeM: r.data.altitudeM,
        speedKt: r.data.speedKt,
        heading: r.data.heading,
        onGround: r.data.onGround,
        source: r.source,
        updatedAt: r.timestamp,
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    return {
      view: VIEW_FLIGHT_FEED,
      generatedAt: context.now().toISOString(),
      items,
    };
  }
}
