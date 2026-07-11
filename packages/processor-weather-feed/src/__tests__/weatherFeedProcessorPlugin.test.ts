import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PulseRecord, RuntimeContext } from "pulsebridge";
import {
  WeatherFeedProcessorPlugin,
  VIEW_WEATHER_FEED,
} from "../weatherFeedProcessorPlugin.js";

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function makeContext(): RuntimeContext {
  return {
    logger: mockLogger,
    now: () => new Date("2024-01-15T12:00:00Z"),
    secrets: { get: () => undefined, has: () => false },
  } as unknown as RuntimeContext;
}

function makeWeatherRecord(city: string, temp: number): PulseRecord {
  return {
    type: "weather.current",
    timestamp: "2024-01-15T11:00:00Z",
    source: "@pulsebridge/integration-openweather",
    entityKey: `city:${city.toLowerCase()}:gb`,
    data: {
      city,
      country: "GB",
      temp,
      feelsLike: temp - 2,
      humidity: 70,
      windSpeed: 5,
      description: "cloudy",
      icon: "04d",
    },
  };
}

describe("WeatherFeedProcessorPlugin", () => {
  let plugin: WeatherFeedProcessorPlugin;

  beforeEach(() => {
    plugin = new WeatherFeedProcessorPlugin();
    vi.clearAllMocks();
  });

  it("should produce a weather-feed view from weather records", async () => {
    const records = [
      makeWeatherRecord("London", 15),
      makeWeatherRecord("Tokyo", 8),
    ];
    const view = await plugin.process(records, makeContext());
    expect(view).not.toBeNull();
    expect(view?.view).toBe(VIEW_WEATHER_FEED);
    expect(view?.items).toHaveLength(2);
    expect(view?.items[0]?.city).toBe("London");
    expect(view?.items[1]?.city).toBe("Tokyo");
  });

  it("should sort cities alphabetically", async () => {
    const records = [
      makeWeatherRecord("Tokyo", 8),
      makeWeatherRecord("London", 15),
    ];
    const view = await plugin.process(records, makeContext());
    expect(view?.items[0]?.city).toBe("London");
    expect(view?.items[1]?.city).toBe("Tokyo");
  });

  it("should deduplicate by entityKey keeping the latest record", async () => {
    const older = {
      ...makeWeatherRecord("London", 10),
      timestamp: "2024-01-15T10:00:00Z",
    };
    const newer = {
      ...makeWeatherRecord("London", 15),
      timestamp: "2024-01-15T11:00:00Z",
    };
    const view = await plugin.process([older, newer], makeContext());
    expect(view?.items).toHaveLength(1);
    expect(view?.items[0]?.temp).toBe(15);
  });

  it("should return null when no weather records are present", async () => {
    const unrelated: PulseRecord = {
      type: "crypto.price",
      timestamp: "2024-01-15T11:00:00Z",
      source: "other",
      data: {},
    };
    const view = await plugin.process([unrelated], makeContext());
    expect(view).toBeNull();
  });

  it("should return null when records array is empty", async () => {
    const view = await plugin.process([], makeContext());
    expect(view).toBeNull();
  });
});
