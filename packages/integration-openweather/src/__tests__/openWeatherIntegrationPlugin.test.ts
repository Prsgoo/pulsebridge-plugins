import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  PluginAuthError,
  PluginKinds,
  RateLimitError,
  TransientError,
} from "pulsebridge";
import {
  OpenWeatherIntegrationPlugin,
  RECORD_TYPE_WEATHER_CURRENT,
  openWeatherConfigSchema,
} from "../openWeatherIntegrationPlugin.js";

const TEST_KEY = "demo-value";

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function makeContext(
  secrets: Record<string, string> = {},
  signal?: AbortSignal,
) {
  return {
    logger: mockLogger,
    now: () => new Date("2024-01-15T12:00:00Z"),
    secrets: {
      get: (k: string) => secrets[k],
      has: (k: string) => k in secrets,
    },
    signal,
  };
}

function makeOkResponse(body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    headers: { get: (h: string) => headers[h] ?? null },
  } as unknown as Response;
}

function makeErrorResponse(
  status: number,
  headers: Record<string, string> = {},
) {
  return {
    ok: false,
    status,
    json: () => Promise.resolve({}),
    headers: { get: (h: string) => headers[h] ?? null },
  } as unknown as Response;
}

const weatherApiResponse = {
  name: "London",
  sys: { country: "GB" },
  main: { temp: 15, feels_like: 13, humidity: 80 },
  wind: { speed: 5 },
  weather: [{ description: "light rain", icon: "10d" }],
};

const withKey = { OPENWEATHER_API_KEY: TEST_KEY };

describe("OpenWeatherIntegrationPlugin", () => {
  let plugin: OpenWeatherIntegrationPlugin;

  beforeEach(() => {
    plugin = new OpenWeatherIntegrationPlugin();
    plugin.configure({ locations: ["London"], units: "metric" });
    vi.clearAllMocks();
  });

  it("should map every weather field from the response", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse(weatherApiResponse),
    );

    const records = await plugin.execute(
      "current-weather",
      makeContext(withKey) as never,
    );

    expect(records[0]?.data).toEqual({
      city: "London",
      country: "GB",
      temp: 15,
      feelsLike: 13,
      humidity: 80,
      windSpeed: 5,
      description: "light rain",
      icon: "10d",
    });
  });

  it("should stamp records with type, source, time and entity key", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse(weatherApiResponse),
    );

    const records = await plugin.execute(
      "current-weather",
      makeContext(withKey) as never,
    );

    expect(records[0]?.type).toBe(RECORD_TYPE_WEATHER_CURRENT);
    expect(records[0]?.source).toBe("@prsgoo/integration-openweather");
    expect(records[0]?.timestamp).toBe("2024-01-15T12:00:00.000Z");
    expect(records[0]?.entityKey).toBe("city:london:gb");
  });

  it("should request the city with the api key and units", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeOkResponse(weatherApiResponse));

    await plugin.execute("current-weather", makeContext(withKey) as never);

    const url = new URL(String(fetchSpy.mock.calls[0]?.[0]));
    expect(url.origin + url.pathname).toBe(
      "https://api.openweathermap.org/data/2.5/weather",
    );
    expect(url.searchParams.get("q")).toBe("London");
    expect(url.searchParams.get("appid")).toBe(TEST_KEY);
    expect(url.searchParams.get("units")).toBe("metric");
  });

  it("should forward the abort signal to fetch", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeOkResponse(weatherApiResponse));
    const controller = new AbortController();

    await plugin.execute(
      "current-weather",
      makeContext(withKey, controller.signal) as never,
    );

    expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it("should pass a null signal when context has none", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeOkResponse(weatherApiResponse));

    await plugin.execute("current-weather", makeContext(withKey) as never);

    expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBeNull();
  });

  it("should log which location it is fetching", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse(weatherApiResponse),
    );

    await plugin.execute("current-weather", makeContext(withKey) as never);

    expect(mockLogger.debug).toHaveBeenCalledWith("Fetching weather.", {
      location: "London",
    });
  });

  it("should skip and warn when API returns 404", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(404));

    const records = await plugin.execute(
      "current-weather",
      makeContext(withKey) as never,
    );

    expect(records).toHaveLength(0);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Location not found — skipping.",
      { location: "London" },
    );
  });

  it("should skip and warn when the weather array is empty", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse({ ...weatherApiResponse, weather: [] }),
    );

    const records = await plugin.execute(
      "current-weather",
      makeContext(withKey) as never,
    );

    expect(records).toHaveLength(0);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Empty weather conditions in response — skipping.",
      { location: "London" },
    );
  });

  it("should throw PluginAuthError when the API key is missing", async () => {
    await expect(
      plugin.execute("current-weather", makeContext() as never),
    ).rejects.toBeInstanceOf(PluginAuthError);
  });

  it("should throw PluginAuthError on 401", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(401));

    await expect(
      plugin.execute("current-weather", makeContext(withKey) as never),
    ).rejects.toBeInstanceOf(PluginAuthError);
  });

  it("should throw RateLimitError on 429", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(429));

    await expect(
      plugin.execute("current-weather", makeContext(withKey) as never),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it("should derive retry delay from the Retry-After header", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeErrorResponse(429, { "Retry-After": "60" }),
    );

    await expect(
      plugin.execute("current-weather", makeContext(withKey) as never),
    ).rejects.toMatchObject({ retryAfterMs: 60_000 });
  });

  it("should leave retry delay unset when no retry header is present", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(429));

    await expect(
      plugin.execute("current-weather", makeContext(withKey) as never),
    ).rejects.toMatchObject({ retryAfterMs: undefined });
  });

  it("should throw TransientError on 500 with status and location in the message", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(500));

    await expect(
      plugin.execute("current-weather", makeContext(withKey) as never),
    ).rejects.toThrow(/HTTP 500.*London/);
  });

  it("should throw TransientError on 500", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(500));

    await expect(
      plugin.execute("current-weather", makeContext(withKey) as never),
    ).rejects.toBeInstanceOf(TransientError);
  });

  it("should throw on unsupported operationId", async () => {
    await expect(
      plugin.execute("unknown-op", makeContext(withKey) as never),
    ).rejects.toThrow("not supported");
  });

  it("should expose the expected manifest", () => {
    expect(plugin.manifest).toEqual({
      id: "@prsgoo/integration-openweather",
      name: "OpenWeatherMap Integration",
      version: "0.1.0",
      kind: PluginKinds.INTEGRATION,
      operations: [
        {
          id: "current-weather",
          name: "Current Weather",
          recordType: "weather.current",
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
        defaultIntervalMs: 300_000,
        minIntervalMs: 120_000,
        hard: false,
      },
      rateLimit: { requestsPerMinute: 60, maxConcurrentRequests: 1 },
    });
  });

  it("should default units to metric", () => {
    expect(openWeatherConfigSchema.parse({ locations: ["London"] }).units).toBe(
      "metric",
    );
  });

  it.each(["metric", "imperial", "standard"])(
    "should accept the %s unit",
    (unit) => {
      expect(
        openWeatherConfigSchema.parse({ locations: ["London"], units: unit })
          .units,
      ).toBe(unit);
    },
  );

  it("should reject an unknown unit", () => {
    expect(() =>
      openWeatherConfigSchema.parse({ locations: ["London"], units: "kelvin" }),
    ).toThrow();
  });

  it("should reject an empty locations list", () => {
    expect(() => openWeatherConfigSchema.parse({ locations: [] })).toThrow();
  });

  it("should reject empty location strings", () => {
    expect(() => openWeatherConfigSchema.parse({ locations: [""] })).toThrow();
  });
});
