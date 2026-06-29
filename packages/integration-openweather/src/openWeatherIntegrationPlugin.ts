import {
  PluginAuthError,
  PluginKinds,
  RateLimitError,
  TransientError,
  type IntegrationPlugin,
  type IntegrationPluginManifest,
  type PulseRecord,
  type RuntimeContext,
} from "pulsebridge";
import { z } from "zod";

export const OPENWEATHER_INTEGRATION_ID = "@prsgoo/integration-openweather";
export const RECORD_TYPE_WEATHER_CURRENT = "weather.current";

const BASE_URL = "https://api.openweathermap.org/data/2.5/weather";

export const openWeatherConfigSchema = z.object({
  /** One or more city names, e.g. "London", "Tokyo,jp", "New York,us". */
  locations: z
    .array(z.string().min(1))
    .min(1, "At least one location is required."),
  /** Temperature unit. Defaults to "metric" (Celsius). */
  units: z.enum(["metric", "imperial", "standard"]).default("metric"),
});

export type OpenWeatherConfig = z.infer<typeof openWeatherConfigSchema>;

export interface WeatherCurrentData {
  city: string;
  country: string;
  /** Temperature in the configured unit. */
  temp: number;
  feelsLike: number;
  humidity: number;
  /** Wind speed in m/s (metric/standard) or mph (imperial). */
  windSpeed: number;
  description: string;
  /** OpenWeatherMap icon code, e.g. "10d". */
  icon: string;
}

interface OWMWeatherCondition {
  description: string;
  icon: string;
}

interface OWMCurrentResponse {
  name: string;
  sys: { country: string };
  main: { temp: number; feels_like: number; humidity: number };
  wind: { speed: number };
  weather: OWMWeatherCondition[];
}

export class OpenWeatherIntegrationPlugin implements IntegrationPlugin<OpenWeatherConfig> {
  readonly manifest: IntegrationPluginManifest = {
    id: OPENWEATHER_INTEGRATION_ID,
    name: "OpenWeatherMap Integration",
    version: "0.1.0",
    kind: PluginKinds.INTEGRATION,
    operations: [
      {
        id: "current-weather",
        name: "Current Weather",
        recordType: RECORD_TYPE_WEATHER_CURRENT,
      },
    ],
    auth: {
      type: "apiKey",
      secrets: [
        {
          key: "OPENWEATHER_API_KEY",
          description: "OpenWeatherMap API key from openweathermap.org",
          required: true,
        },
      ],
    },
    polling: {
      defaultIntervalMs: 5 * 60_000,
      minIntervalMs: 2 * 60_000,
      hard: false,
    },
    rateLimit: {
      requestsPerMinute: 60,
      maxConcurrentRequests: 1,
    },
  };

  readonly configSchema = openWeatherConfigSchema;

  private config: OpenWeatherConfig = { locations: [], units: "metric" };

  configure(config: OpenWeatherConfig): void {
    this.config = config;
  }

  async execute(
    operationId: string,
    context: RuntimeContext,
  ): Promise<ReadonlyArray<PulseRecord<WeatherCurrentData>>> {
    if (operationId !== "current-weather") {
      throw new Error(
        `Operation '${operationId}' is not supported by '${this.manifest.id}'.`,
      );
    }

    const apiKey = context.secrets.get("OPENWEATHER_API_KEY");
    if (!apiKey) {
      throw new PluginAuthError(
        "OPENWEATHER_API_KEY secret is required but not set.",
      );
    }
    const records: PulseRecord<WeatherCurrentData>[] = [];

    for (const location of this.config.locations) {
      const url = new URL(BASE_URL);
      url.searchParams.set("q", location);
      url.searchParams.set("appid", apiKey);
      url.searchParams.set("units", this.config.units);

      context.logger.debug("Fetching weather.", { location });

      const response = await fetch(url.toString(), {
        signal: context.signal ?? null,
      });

      if (response.status === 401) {
        throw new PluginAuthError("Invalid OpenWeatherMap API key.");
      }

      if (response.status === 429) {
        const retryAfter = response.headers.get("Retry-After");
        throw new RateLimitError(
          "OpenWeatherMap rate limit reached.",
          retryAfter !== null ? parseInt(retryAfter, 10) * 1000 : undefined,
        );
      }

      if (response.status === 404) {
        context.logger.warn("Location not found — skipping.", { location });
        continue;
      }

      if (!response.ok) {
        throw new TransientError(
          `OpenWeatherMap returned HTTP ${response.status} for location '${location}'.`,
        );
      }

      const data = (await response.json()) as OWMCurrentResponse;
      const condition = data.weather[0];

      if (!condition) {
        context.logger.warn(
          "Empty weather conditions in response — skipping.",
          {
            location,
          },
        );
        continue;
      }

      records.push({
        type: RECORD_TYPE_WEATHER_CURRENT,
        timestamp: context.now().toISOString(),
        source: OPENWEATHER_INTEGRATION_ID,
        entityKey: `city:${data.name.toLowerCase()}:${data.sys.country.toLowerCase()}`,
        data: {
          city: data.name,
          country: data.sys.country,
          temp: data.main.temp,
          feelsLike: data.main.feels_like,
          humidity: data.main.humidity,
          windSpeed: data.wind.speed,
          description: condition.description,
          icon: condition.icon,
        },
      });
    }

    return records;
  }
}
