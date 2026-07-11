import {
  PluginKinds,
  type ProcessorPlugin,
  type ProcessorPluginManifest,
  type PulseRecord,
  type PulseViewRecord,
  type RuntimeContext,
} from "pulsebridge";

export const WEATHER_FEED_PROCESSOR_ID = "@prsgoo/processor-weather-feed";
export const RECORD_TYPE_WEATHER_CURRENT = "weather.current";
export const VIEW_WEATHER_FEED = "weather-feed";

export interface WeatherFeedItem {
  city: string;
  country: string;
  temp: number;
  feelsLike: number;
  humidity: number;
  /** Wind speed in the unit configured by the integration. */
  windSpeed: number;
  description: string;
  icon: string;
  updatedAt: string;
}

interface WeatherCurrentData {
  city: string;
  country: string;
  temp: number;
  feelsLike: number;
  humidity: number;
  windSpeed: number;
  description: string;
  icon: string;
}

export class WeatherFeedProcessorPlugin implements ProcessorPlugin {
  readonly manifest: ProcessorPluginManifest = {
    id: WEATHER_FEED_PROCESSOR_ID,
    name: "Weather Feed Processor",
    version: "0.1.0",
    kind: PluginKinds.PROCESSOR,
    consumes: [RECORD_TYPE_WEATHER_CURRENT],
    produces: [VIEW_WEATHER_FEED],
  };

  async process(
    records: ReadonlyArray<PulseRecord>,
    context: RuntimeContext,
  ): Promise<PulseViewRecord<WeatherFeedItem> | null> {
    const weatherRecords = records.filter(
      (r) => r.type === RECORD_TYPE_WEATHER_CURRENT,
    ) as ReadonlyArray<PulseRecord<WeatherCurrentData>>;
    if (weatherRecords.length === 0) {
      context.logger.debug("No weather records to process.", {
        pluginId: WEATHER_FEED_PROCESSOR_ID,
      });
      return null;
    }

    const latestByCity = new Map<string, PulseRecord<WeatherCurrentData>>();
    for (const record of weatherRecords) {
      const key = record.entityKey ?? record.data.city;
      const existing = latestByCity.get(key);
      if (!existing || record.timestamp > existing.timestamp) {
        latestByCity.set(key, record);
      }
    }

    const items: WeatherFeedItem[] = Array.from(latestByCity.values())
      .map((r) => ({
        city: r.data.city,
        country: r.data.country,
        temp: r.data.temp,
        feelsLike: r.data.feelsLike,
        humidity: r.data.humidity,
        windSpeed: r.data.windSpeed,
        description: r.data.description,
        icon: r.data.icon,
        updatedAt: r.timestamp,
      }))
      .sort((a, b) => a.city.localeCompare(b.city));

    return {
      view: VIEW_WEATHER_FEED,
      generatedAt: context.now().toISOString(),
      items,
    };
  }
}
