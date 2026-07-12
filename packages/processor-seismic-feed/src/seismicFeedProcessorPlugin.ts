import {
  PluginKinds,
  type ProcessorPlugin,
  type ProcessorPluginManifest,
  type PulseRecord,
  type PulseViewRecord,
  type RuntimeContext,
} from "pulsebridge";

export const SEISMIC_FEED_PROCESSOR_ID = "@prsgoo/processor-seismic-feed";
export const RECORD_TYPE_SEISMIC_EVENT = "seismic.event";
export const VIEW_SEISMIC_FEED = "seismic-feed";

export interface SeismicFeedItem {
  /** Stable identifier for the event (the record's entityKey). */
  id: string;
  magnitude: number;
  magnitudeType: string;
  place: string;
  depth: number;
  latitude: number;
  longitude: number;
  significance: number;
  tsunami: boolean;
  alert: "green" | "yellow" | "orange" | "red" | null;
  url: string;
  /** ISO timestamp of when the earthquake occurred. */
  eventTime: string;
  /** ISO timestamp of when this event was last ingested. */
  updatedAt: string;
}

interface SeismicEventData {
  magnitude: number;
  magnitudeType: string;
  place: string;
  depth: number;
  latitude: number;
  longitude: number;
  significance: number;
  tsunami: boolean;
  alert: "green" | "yellow" | "orange" | "red" | null;
  url: string;
  eventTime: string;
}

export class SeismicFeedProcessorPlugin implements ProcessorPlugin {
  readonly manifest: ProcessorPluginManifest = {
    id: SEISMIC_FEED_PROCESSOR_ID,
    name: "Seismic Feed Processor",
    version: "0.1.0",
    kind: PluginKinds.PROCESSOR,
    consumes: [RECORD_TYPE_SEISMIC_EVENT],
    produces: [VIEW_SEISMIC_FEED],
  };

  async process(
    records: ReadonlyArray<PulseRecord>,
    context: RuntimeContext,
  ): Promise<PulseViewRecord<SeismicFeedItem> | null> {
    const seismicRecords = records.filter(
      (r) => r.type === RECORD_TYPE_SEISMIC_EVENT,
    ) as ReadonlyArray<PulseRecord<SeismicEventData>>;
    if (seismicRecords.length === 0) {
      context.logger.debug("No seismic records to process.", {
        pluginId: SEISMIC_FEED_PROCESSOR_ID,
      });
      return null;
    }

    const latestById = new Map<string, PulseRecord<SeismicEventData>>();
    for (const record of seismicRecords) {
      const key =
        record.entityKey ??
        `${record.data.latitude},${record.data.longitude},${record.data.eventTime}`;
      const existing = latestById.get(key);
      if (!existing || record.timestamp > existing.timestamp) {
        latestById.set(key, record);
      }
    }

    const items: SeismicFeedItem[] = Array.from(latestById.entries())
      .map(([id, r]) => ({
        id,
        magnitude: r.data.magnitude,
        magnitudeType: r.data.magnitudeType,
        place: r.data.place,
        depth: r.data.depth,
        latitude: r.data.latitude,
        longitude: r.data.longitude,
        significance: r.data.significance,
        tsunami: r.data.tsunami,
        alert: r.data.alert,
        url: r.data.url,
        eventTime: r.data.eventTime,
        updatedAt: r.timestamp,
      }))
      .sort((a, b) => b.magnitude - a.magnitude);

    return {
      view: VIEW_SEISMIC_FEED,
      generatedAt: context.now().toISOString(),
      items,
    };
  }
}
