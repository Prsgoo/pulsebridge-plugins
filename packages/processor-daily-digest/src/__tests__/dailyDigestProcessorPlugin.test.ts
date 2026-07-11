import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PulseRecord, PulseViewRecord, RuntimeContext } from "pulsebridge";
import {
  DailyDigestProcessorPlugin,
  VIEW_DAILY_DIGEST,
} from "../dailyDigestProcessorPlugin.js";

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

function makeApodRecord(): PulseRecord {
  return {
    type: "space.apod",
    timestamp: "2024-01-15T11:00:00Z",
    source: "@pulsebridge/integration-nasa-apod",
    entityKey: "apod:2024-01-15",
    data: {
      title: "Pillars of Creation",
      explanation: "A famous nebula...",
      date: "2024-01-15",
      url: "https://apod.nasa.gov/apod/image/pillars.jpg",
      hdurl: "https://apod.nasa.gov/apod/image/pillars_hd.jpg",
      mediaType: "image",
    },
  };
}

function makeWeatherView(): PulseViewRecord {
  return {
    view: "weather-feed",
    generatedAt: "2024-01-15T11:30:00Z",
    items: [{ city: "London", country: "GB", temp: 15, description: "cloudy" }],
  } as unknown as PulseViewRecord;
}

function makeCryptoView(): PulseViewRecord {
  return {
    view: "crypto-ticker",
    generatedAt: "2024-01-15T11:30:00Z",
    items: [
      {
        coinId: "bitcoin",
        symbol: "BTC",
        priceUsd: 42000,
        change24hPercent: 2.5,
        direction: "up",
      },
    ],
  } as unknown as PulseViewRecord;
}

describe("DailyDigestProcessorPlugin", () => {
  let plugin: DailyDigestProcessorPlugin;

  beforeEach(() => {
    plugin = new DailyDigestProcessorPlugin();
    vi.clearAllMocks();
  });

  it("should produce a daily-digest view with all data present", async () => {
    const records = [makeApodRecord()];
    const views = [makeWeatherView(), makeCryptoView()];
    const view = await plugin.process(records, makeContext(), views);
    expect(view?.view).toBe(VIEW_DAILY_DIGEST);
    expect(view?.items).toHaveLength(1);
    const digest = view?.items[0];
    expect(digest?.weather.locationCount).toBe(1);
    expect(digest?.weather.highlights[0]?.city).toBe("London");
    expect(digest?.crypto?.coinCount).toBe(1);
    expect(digest?.crypto?.highlights[0]?.symbol).toBe("BTC");
    expect(digest?.spaceOfTheDay?.title).toBe("Pillars of Creation");
    expect(digest?.spaceOfTheDay?.imageUrl).toBe(
      "https://apod.nasa.gov/apod/image/pillars_hd.jpg",
    );
  });

  it("should produce a digest with null crypto when no crypto view", async () => {
    const view = await plugin.process([makeApodRecord()], makeContext(), [
      makeWeatherView(),
    ]);
    expect(view?.items[0]?.crypto).toBeNull();
  });

  it("should produce a digest with null spaceOfTheDay when no APOD records", async () => {
    const view = await plugin.process([], makeContext(), [
      makeWeatherView(),
      makeCryptoView(),
    ]);
    expect(view?.items[0]?.spaceOfTheDay).toBeNull();
  });

  it("should fall back to url when hdurl is absent for spaceOfTheDay", async () => {
    const base = makeApodRecord();
    const apodNoHd: PulseRecord = {
      ...base,
      data: {
        ...(base.data as Record<string, unknown>),
        hdurl: undefined,
      },
    };
    const view = await plugin.process([apodNoHd], makeContext(), []);
    expect(view?.items[0]?.spaceOfTheDay?.imageUrl).toBe(
      "https://apod.nasa.gov/apod/image/pillars.jpg",
    );
  });

  it("should produce a digest when views are undefined", async () => {
    const view = await plugin.process([makeApodRecord()], makeContext());
    expect(view?.view).toBe(VIEW_DAILY_DIGEST);
    expect(view?.items[0]?.weather.locationCount).toBe(0);
    expect(view?.items[0]?.crypto).toBeNull();
  });

  it("should pick the most recent APOD when multiple are present", async () => {
    const base = makeApodRecord();
    const older: PulseRecord = {
      ...base,
      data: {
        ...(base.data as Record<string, unknown>),
        date: "2024-01-14",
        title: "Older APOD",
      },
    };
    const newer: PulseRecord = {
      ...base,
      data: {
        ...(base.data as Record<string, unknown>),
        date: "2024-01-15",
        title: "Newer APOD",
      },
    };
    const view = await plugin.process([older, newer], makeContext(), []);
    expect(view?.items[0]?.spaceOfTheDay?.title).toBe("Newer APOD");
  });
});
