import {
  PluginKinds,
  type ProcessorPlugin,
  type ProcessorPluginManifest,
  type PulseRecord,
  type PulseViewRecord,
  type RuntimeContext,
} from "pulsebridge";

export const DAILY_DIGEST_PROCESSOR_ID = "@prsgoo/processor-daily-digest";
export const RECORD_TYPE_WEATHER_CURRENT = "weather.current";
export const RECORD_TYPE_SPACE_APOD = "space.apod";
export const RECORD_TYPE_CRYPTO_PRICE = "crypto.price";
export const VIEW_WEATHER_FEED = "weather-feed";
export const VIEW_CRYPTO_TICKER = "crypto-ticker";
export const VIEW_DAILY_DIGEST = "daily-digest";

export interface WeatherHighlight {
  city: string;
  country: string;
  temp: number;
  description: string;
}

export interface CryptoHighlight {
  symbol: string;
  priceUsd: number;
  change24hPercent: number;
  direction: "up" | "down" | "flat";
}

export interface SpaceOfTheDay {
  title: string;
  explanation: string;
  date: string;
  imageUrl: string;
  copyright?: string;
}

export interface DailyDigestData {
  weather: {
    locationCount: number;
    highlights: WeatherHighlight[];
  };
  crypto: {
    coinCount: number;
    highlights: CryptoHighlight[];
  } | null;
  spaceOfTheDay: SpaceOfTheDay | null;
}

interface ApodData {
  title: string;
  explanation: string;
  date: string;
  url: string;
  hdurl?: string;
  copyright?: string;
}

// Shapes of the upstream processor view items this digest reads via consumesViews.
interface WeatherFeedItemShape {
  city: string;
  country: string;
  temp: number;
  description: string;
}

interface CryptoTickerItemShape {
  symbol: string;
  priceUsd: number;
  change24hPercent: number;
  direction: "up" | "down" | "flat";
}

export class DailyDigestProcessorPlugin implements ProcessorPlugin {
  readonly manifest: ProcessorPluginManifest = {
    id: DAILY_DIGEST_PROCESSOR_ID,
    name: "Daily Digest Processor",
    version: "0.1.0",
    kind: PluginKinds.PROCESSOR,
    consumes: [
      RECORD_TYPE_WEATHER_CURRENT,
      RECORD_TYPE_SPACE_APOD,
      RECORD_TYPE_CRYPTO_PRICE,
    ],
    consumesViews: [VIEW_WEATHER_FEED, VIEW_CRYPTO_TICKER],
    produces: [VIEW_DAILY_DIGEST],
  };

  async process(
    records: ReadonlyArray<PulseRecord>,
    context: RuntimeContext,
    views?: ReadonlyArray<PulseViewRecord>,
  ): Promise<PulseViewRecord<DailyDigestData> | null> {
    const weatherView = views?.find((v) => v.view === VIEW_WEATHER_FEED);
    const cryptoView = views?.find((v) => v.view === VIEW_CRYPTO_TICKER);

    const weatherItems = (weatherView?.items ??
      []) as ReadonlyArray<WeatherFeedItemShape>;
    const cryptoItems = (cryptoView?.items ??
      []) as ReadonlyArray<CryptoTickerItemShape>;

    const apodRecords = (
      records.filter(
        (r) => r.type === RECORD_TYPE_SPACE_APOD,
      ) as PulseRecord<ApodData>[]
    ).sort((a, b) => b.data.date.localeCompare(a.data.date));
    const latestApod = apodRecords[0];

    const spaceOfTheDay: SpaceOfTheDay | null = latestApod
      ? {
          title: latestApod.data.title,
          explanation: latestApod.data.explanation,
          date: latestApod.data.date,
          imageUrl: latestApod.data.hdurl ?? latestApod.data.url,
          ...(latestApod.data.copyright !== undefined
            ? { copyright: latestApod.data.copyright }
            : {}),
        }
      : null;

    const weatherHighlights: WeatherHighlight[] = weatherItems.map((item) => ({
      city: item.city,
      country: item.country,
      temp: item.temp,
      description: item.description,
    }));
    const cryptoHighlights: CryptoHighlight[] = cryptoItems.map((item) => ({
      symbol: item.symbol,
      priceUsd: item.priceUsd,
      change24hPercent: item.change24hPercent,
      direction: item.direction,
    }));

    context.logger.debug("Building daily digest.", {
      weatherLocations: weatherHighlights.length,
      cryptoCoins: cryptoHighlights.length,
      hasApod: spaceOfTheDay !== null,
    });

    return {
      view: VIEW_DAILY_DIGEST,
      generatedAt: context.now().toISOString(),
      items: [
        {
          weather: {
            locationCount: weatherHighlights.length,
            highlights: weatherHighlights,
          },
          crypto:
            cryptoHighlights.length > 0
              ? {
                  coinCount: cryptoHighlights.length,
                  highlights: cryptoHighlights,
                }
              : null,
          spaceOfTheDay,
        },
      ],
    };
  }
}
