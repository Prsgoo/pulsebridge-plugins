import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  PluginAuthError,
  PluginKinds,
  RateLimitError,
  TransientError,
} from "pulsebridge";
import {
  NasaApodIntegrationPlugin,
  RECORD_TYPE_SPACE_APOD,
  nasaApodConfigSchema,
} from "../nasaApodIntegrationPlugin.js";

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

const apodItem = {
  title: "Galaxy NGC 1232",
  explanation: "A majestic spiral galaxy...",
  date: "2024-01-15",
  url: "https://apod.nasa.gov/apod/image/galaxy.jpg",
  hdurl: "https://apod.nasa.gov/apod/image/galaxy_hd.jpg",
  media_type: "image",
  copyright: "NASA",
};

const withKey = { NASA_API_KEY: TEST_KEY };

describe("NasaApodIntegrationPlugin", () => {
  let plugin: NasaApodIntegrationPlugin;

  beforeEach(() => {
    plugin = new NasaApodIntegrationPlugin();
    plugin.configure({ count: 1 });
    vi.clearAllMocks();
  });

  it("should map every field from an array response", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeOkResponse([apodItem]));

    const records = await plugin.execute(
      "fetch-apod",
      makeContext(withKey) as never,
    );

    expect(records[0]?.data).toEqual({
      title: "Galaxy NGC 1232",
      explanation: "A majestic spiral galaxy...",
      date: "2024-01-15",
      url: "https://apod.nasa.gov/apod/image/galaxy.jpg",
      hdurl: "https://apod.nasa.gov/apod/image/galaxy_hd.jpg",
      mediaType: "image",
      copyright: "NASA",
    });
  });

  it("should stamp records with type, source, time and entity key", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeOkResponse([apodItem]));

    const records = await plugin.execute(
      "fetch-apod",
      makeContext(withKey) as never,
    );

    expect(records[0]?.type).toBe(RECORD_TYPE_SPACE_APOD);
    expect(records[0]?.source).toBe("@prsgoo/integration-nasa-apod");
    expect(records[0]?.timestamp).toBe("2024-01-15T12:00:00.000Z");
    expect(records[0]?.entityKey).toBe("apod:2024-01-15");
  });

  it("should return a single record from a non-array response", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeOkResponse(apodItem));

    const records = await plugin.execute(
      "fetch-apod",
      makeContext(withKey) as never,
    );

    expect(records).toHaveLength(1);
  });

  it("should omit optional fields when absent", async () => {
    const noOptional = {
      ...apodItem,
      hdurl: undefined,
      copyright: undefined,
    };
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse([noOptional]),
    );

    const records = await plugin.execute(
      "fetch-apod",
      makeContext(withKey) as never,
    );

    expect(Object.keys(records[0]?.data ?? {})).not.toContain("hdurl");
    expect(Object.keys(records[0]?.data ?? {})).not.toContain("copyright");
  });

  it("should request the APOD endpoint with key, thumbs and count", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeOkResponse([apodItem]));

    await plugin.execute("fetch-apod", makeContext(withKey) as never);

    const url = new URL(String(fetchSpy.mock.calls[0]?.[0]));
    expect(url.origin + url.pathname).toBe(
      "https://api.nasa.gov/planetary/apod",
    );
    expect(url.searchParams.get("api_key")).toBe(TEST_KEY);
    expect(url.searchParams.get("thumbs")).toBe("true");
    expect(url.searchParams.get("count")).toBe("1");
  });

  it("should omit the count param when not configured", async () => {
    plugin.configure({});
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeOkResponse([apodItem]));

    await plugin.execute("fetch-apod", makeContext(withKey) as never);

    const url = new URL(String(fetchSpy.mock.calls[0]?.[0]));
    expect(url.searchParams.has("count")).toBe(false);
  });

  it("should forward the abort signal to fetch", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeOkResponse([apodItem]));
    const controller = new AbortController();

    await plugin.execute(
      "fetch-apod",
      makeContext(withKey, controller.signal) as never,
    );

    expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it("should pass a null signal when context has none", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeOkResponse([apodItem]));

    await plugin.execute("fetch-apod", makeContext(withKey) as never);

    expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBeNull();
  });

  it("should throw PluginAuthError when the API key is missing", async () => {
    await expect(
      plugin.execute("fetch-apod", makeContext() as never),
    ).rejects.toBeInstanceOf(PluginAuthError);
  });

  it("should throw PluginAuthError on 403", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(403));

    await expect(
      plugin.execute("fetch-apod", makeContext(withKey) as never),
    ).rejects.toBeInstanceOf(PluginAuthError);
  });

  it("should throw RateLimitError on 429", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(429));

    await expect(
      plugin.execute("fetch-apod", makeContext(withKey) as never),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it("should derive retry delay from X-Retry-After", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeErrorResponse(429, { "X-Retry-After": "45" }),
    );

    await expect(
      plugin.execute("fetch-apod", makeContext(withKey) as never),
    ).rejects.toMatchObject({ retryAfterMs: 45_000 });
  });

  it("should fall back to Retry-After when X-Retry-After is absent", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeErrorResponse(429, { "Retry-After": "12" }),
    );

    await expect(
      plugin.execute("fetch-apod", makeContext(withKey) as never),
    ).rejects.toMatchObject({ retryAfterMs: 12_000 });
  });

  it("should leave retry delay unset when no retry header is present", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(429));

    await expect(
      plugin.execute("fetch-apod", makeContext(withKey) as never),
    ).rejects.toMatchObject({ retryAfterMs: undefined });
  });

  it("should throw TransientError on 500 with the status in the message", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(500));

    await expect(
      plugin.execute("fetch-apod", makeContext(withKey) as never),
    ).rejects.toThrow(/HTTP 500/);
  });

  it("should throw TransientError on 500", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(500));

    await expect(
      plugin.execute("fetch-apod", makeContext(withKey) as never),
    ).rejects.toBeInstanceOf(TransientError);
  });

  it("should throw on unsupported operationId", async () => {
    await expect(
      plugin.execute("unknown-op", makeContext(withKey) as never),
    ).rejects.toThrow("not supported");
  });

  it("should expose the expected manifest", () => {
    expect(plugin.manifest).toEqual({
      id: "@prsgoo/integration-nasa-apod",
      name: "NASA Astronomy Picture of the Day",
      version: "0.1.0",
      kind: PluginKinds.INTEGRATION,
      operations: [
        {
          id: "fetch-apod",
          name: "Fetch APOD",
          recordType: "space.apod",
        },
      ],
      auth: {
        type: "apiKey",
        secrets: [
          {
            key: "NASA_API_KEY",
            description:
              "NASA API key from api.nasa.gov. Use DEMO_KEY for casual testing (30 req/hr limit).",
            required: true,
          },
        ],
      },
      polling: {
        defaultIntervalMs: 21_600_000,
        minIntervalMs: 3_600_000,
        hard: false,
      },
      rateLimit: { requestsPerMinute: 30, maxConcurrentRequests: 1 },
    });
  });

  it("should accept a valid count", () => {
    expect(nasaApodConfigSchema.parse({ count: 50 }).count).toBe(50);
  });

  it("should reject a count below 1", () => {
    expect(() => nasaApodConfigSchema.parse({ count: 0 })).toThrow();
  });

  it("should reject a count above 100", () => {
    expect(() => nasaApodConfigSchema.parse({ count: 101 })).toThrow();
  });

  it("should log the configured count", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeOkResponse([apodItem]));

    await plugin.execute("fetch-apod", makeContext(withKey) as never);

    expect(mockLogger.debug).toHaveBeenCalledWith("Fetching APOD.", {
      count: 1,
    });
  });
});
