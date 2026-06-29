import { describe, it, expect, vi, beforeEach } from "vitest";
import { PluginKinds, TransientError } from "pulsebridge";
import {
  GdeltNewsIntegrationPlugin,
  RECORD_TYPE_NEWS_EVENT,
  gdeltConfigSchema,
} from "../gdeltNewsIntegrationPlugin.js";

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function makeContext(signal?: AbortSignal) {
  return {
    logger: mockLogger,
    now: () => new Date("2024-01-15T12:00:00Z"),
    secrets: { get: () => undefined, has: () => false },
    signal,
  };
}

function makeOkResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(body)),
    headers: { get: () => null },
  } as unknown as Response;
}

function makeOkTextResponse(text: string) {
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(text),
    headers: { get: () => null },
  } as unknown as Response;
}

function makeErrorResponse(status: number) {
  return {
    ok: false,
    status,
    text: () => Promise.resolve("{}"),
    headers: { get: () => null },
  } as unknown as Response;
}

const gdeltArticle = {
  title: "Major Earthquake Hits Region",
  url: "https://example.com/article1",
  domain: "example.com",
  language: "English",
  sourcecountry: "US",
  seendate: "20240115100000",
  socialimage: "https://example.com/image.jpg",
};

describe("GdeltNewsIntegrationPlugin", () => {
  let plugin: GdeltNewsIntegrationPlugin;

  beforeEach(() => {
    plugin = new GdeltNewsIntegrationPlugin();
    plugin.configure({
      query: "earthquake",
      maxRecords: 10,
      timespan: "1h",
    });
    vi.clearAllMocks();
  });

  it("should return news event records on successful response", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse({ articles: [gdeltArticle] }),
    );

    const records = await plugin.execute(
      "fetch-articles",
      makeContext() as never,
    );

    expect(records).toHaveLength(1);
    expect(records[0]?.type).toBe(RECORD_TYPE_NEWS_EVENT);
    expect(records[0]?.entityKey).toBe("gdelt:example.com:20240115100000");
    expect(records[0]?.data.title).toBe("Major Earthquake Hits Region");
    expect(records[0]?.data.seenDate).toBe("2024-01-15T10:00:00Z");
    expect(records[0]?.data.socialImage).toBe("https://example.com/image.jpg");
  });

  it("should map every article field into the record", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse({ articles: [gdeltArticle] }),
    );

    const records = await plugin.execute(
      "fetch-articles",
      makeContext() as never,
    );

    expect(records[0]).toMatchObject({
      type: RECORD_TYPE_NEWS_EVENT,
      source: "@prsgoo/integration-gdelt-news",
      timestamp: "2024-01-15T12:00:00.000Z",
      entityKey: "gdelt:example.com:20240115100000",
      data: {
        title: "Major Earthquake Hits Region",
        url: "https://example.com/article1",
        domain: "example.com",
        language: "English",
        sourceCountry: "US",
        seenDate: "2024-01-15T10:00:00Z",
        socialImage: "https://example.com/image.jpg",
      },
    });
  });

  it("should request the DOC API with the configured query and params", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeOkResponse({ articles: [] }));

    await plugin.execute("fetch-articles", makeContext() as never);

    const url = new URL(String(fetchSpy.mock.calls[0]?.[0]));
    expect(url.origin + url.pathname).toBe(
      "https://api.gdeltproject.org/api/v2/doc/doc",
    );
    expect(url.searchParams.get("query")).toBe("earthquake");
    expect(url.searchParams.get("mode")).toBe("artlist");
    expect(url.searchParams.get("maxrecords")).toBe("10");
    expect(url.searchParams.get("timespan")).toBe("1h");
    expect(url.searchParams.get("format")).toBe("json");
  });

  it("should forward the abort signal to fetch", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeOkResponse({ articles: [] }));
    const controller = new AbortController();

    await plugin.execute(
      "fetch-articles",
      makeContext(controller.signal) as never,
    );

    expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it("should pass a null signal when context has none", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeOkResponse({ articles: [] }));

    await plugin.execute("fetch-articles", makeContext() as never);

    expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBeNull();
  });

  it("should return empty array when articles key is missing", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeOkResponse({}));

    const records = await plugin.execute(
      "fetch-articles",
      makeContext() as never,
    );

    expect(records).toHaveLength(0);
  });

  it("should omit socialImage when not present in article", async () => {
    const articleNoImage = { ...gdeltArticle, socialimage: undefined };
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse({ articles: [articleNoImage] }),
    );

    const records = await plugin.execute(
      "fetch-articles",
      makeContext() as never,
    );

    expect(Object.keys(records[0]?.data ?? {})).not.toContain("socialImage");
  });

  it("should throw TransientError on non-ok response", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(500));

    await expect(
      plugin.execute("fetch-articles", makeContext() as never),
    ).rejects.toBeInstanceOf(TransientError);
  });

  it("should include the status code in the non-ok error message", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(503));

    await expect(
      plugin.execute("fetch-articles", makeContext() as never),
    ).rejects.toThrow(/HTTP 503/);
  });

  it("should throw TransientError when GDELT returns a non-JSON 200 body", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkTextResponse("Timespan is too short.\n"),
    );

    await expect(
      plugin.execute("fetch-articles", makeContext() as never),
    ).rejects.toBeInstanceOf(TransientError);
  });

  it("should echo the offending body in the non-JSON error message", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkTextResponse("Timespan is too short.\n"),
    );

    await expect(
      plugin.execute("fetch-articles", makeContext() as never),
    ).rejects.toThrow(/Timespan is too short/);
  });

  it("should throw on unsupported operationId", async () => {
    await expect(
      plugin.execute("unknown-op", makeContext() as never),
    ).rejects.toThrow("not supported");
  });

  it("should expose the expected manifest", () => {
    expect(plugin.manifest).toEqual({
      id: "@prsgoo/integration-gdelt-news",
      name: "GDELT News",
      version: "0.1.0",
      kind: PluginKinds.INTEGRATION,
      operations: [
        {
          id: "fetch-articles",
          name: "Fetch Articles",
          recordType: "news.event",
        },
      ],
      auth: { type: "none" },
      polling: {
        defaultIntervalMs: 900_000,
        minIntervalMs: 900_000,
        hard: false,
      },
      rateLimit: { requestsPerMinute: 10, maxConcurrentRequests: 1 },
    });
  });

  it("should default the query to the built-in conflict filter", () => {
    expect(gdeltConfigSchema.parse({}).query).toBe(
      "(war OR conflict OR disaster OR earthquake OR storm)",
    );
  });

  it("should default maxRecords to 50", () => {
    expect(gdeltConfigSchema.parse({}).maxRecords).toBe(50);
  });

  it("should default the timespan to 1h", () => {
    expect(gdeltConfigSchema.parse({}).timespan).toBe("1h");
  });

  it("should reject an empty query", () => {
    expect(() => gdeltConfigSchema.parse({ query: "" })).toThrow();
  });

  it("should reject maxRecords below 1", () => {
    expect(() => gdeltConfigSchema.parse({ maxRecords: 0 })).toThrow();
  });

  it("should reject maxRecords above 250", () => {
    expect(() => gdeltConfigSchema.parse({ maxRecords: 251 })).toThrow();
  });
});
