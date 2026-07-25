import {
  PluginKinds,
  type ProcessorPlugin,
  type ProcessorPluginManifest,
  type PulseRecord,
  type PulseViewRecord,
  type RuntimeContext,
} from "pulsebridge";

export const WILDFIRE_FEED_PROCESSOR_ID = "@prsgoo/processor-wildfire-feed";
export const RECORD_TYPE_WILDFIRE_EVENT = "wildfire.event";
export const VIEW_WILDFIRE_FEED = "wildfire-feed";

export interface WildfireFeedItem {
  id: string;
  latitude: number;
  longitude: number;
  brightness: number;
  frp: number;
  confidence: string;
  instrument: string;
  acquisitionDate: string;
  acquisitionTime: string;
  satellite: string;
  updatedAt: string;
}

interface WildfireEventData {
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

export class WildfireFeedProcessorPlugin implements ProcessorPlugin {
  readonly manifest: ProcessorPluginManifest = {
    id: WILDFIRE_FEED_PROCESSOR_ID,
    name: "Wildfire Feed",
    version: "0.1.0-beta.1",
    kind: PluginKinds.PROCESSOR,
    consumes: [RECORD_TYPE_WILDFIRE_EVENT],
    produces: [VIEW_WILDFIRE_FEED],
  };

  async process(
    records: ReadonlyArray<PulseRecord>,
    context: RuntimeContext,
  ): Promise<PulseViewRecord<WildfireFeedItem> | null> {
    const wildfireRecords = records.filter(
      (r) => r.type === RECORD_TYPE_WILDFIRE_EVENT,
    ) as ReadonlyArray<PulseRecord<WildfireEventData>>;

    if (wildfireRecords.length === 0) {
      context.logger.debug("No wildfire records to process.", {
        pluginId: WILDFIRE_FEED_PROCESSOR_ID,
      });
      return null;
    }

    const latestById = new Map<string, PulseRecord<WildfireEventData>>();
    for (const record of wildfireRecords) {
      const key = record.entityKey;
      if (!key) continue;
      const existing = latestById.get(key);
      if (!existing || record.timestamp > existing.timestamp) {
        latestById.set(key, record);
      }
    }

    const items: WildfireFeedItem[] = Array.from(latestById.entries())
      .map(([id, r]) => ({
        id,
        latitude: r.data.latitude,
        longitude: r.data.longitude,
        brightness: r.data.brightness,
        frp: r.data.frp,
        confidence: r.data.confidence,
        instrument: r.data.instrument,
        acquisitionDate: r.data.acquisitionDate,
        acquisitionTime: r.data.acquisitionTime,
        satellite: r.data.satellite,
        updatedAt: r.timestamp,
      }))
      .sort((a, b) => b.frp - a.frp);

    return {
      view: VIEW_WILDFIRE_FEED,
      generatedAt: context.now().toISOString(),
      items,
    };
  }
}
