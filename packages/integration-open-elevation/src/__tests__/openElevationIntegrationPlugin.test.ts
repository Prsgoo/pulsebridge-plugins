import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  PluginInputError,
  RateLimitError,
  TransientError,
  type RuntimeContext,
} from "pulsebridge";
import {
  OpenElevationIntegrationPlugin,
  ACTION_LOOKUP,
  RECORD_TYPE_ELEVATION,
} from "../openElevationIntegrationPlugin.js";

function makeContext(): RuntimeContext {
  return {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    now: () => new Date("2024-01-15T12:00:00Z"),
    secrets: { get: () => undefined, has: () => false },
  } as unknown as RuntimeContext;
}

function stubFetch(init: {
  ok?: boolean;
  status?: number;
  json?: unknown;
  headers?: Record<string, string>;
}) {
  const headers = init.headers ?? {};
  const response = {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers: { get: (key: string) => headers[key] ?? null },
    json: () => Promise.resolve(init.json),
  };
  const fn = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fn);
  return fn;
}

const ONE_LOCATION = { locations: [{ latitude: 40, longitude: -3 }] };

describe("OpenElevationIntegrationPlugin", () => {
  let plugin: OpenElevationIntegrationPlugin;

  beforeEach(() => {
    plugin = new OpenElevationIntegrationPlugin();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("should look up elevation and return points plus records", async () => {
    stubFetch({
      json: { results: [{ latitude: 40, longitude: -3, elevation: 667 }] },
    });
    const result = await plugin.invoke(
      ACTION_LOOKUP,
      makeContext(),
      ONE_LOCATION,
    );
    expect(result.data).toEqual([
      { latitude: 40, longitude: -3, elevationMeters: 667 },
    ]);
    expect(result.records).toHaveLength(1);
    expect(result.records?.[0]?.type).toBe(RECORD_TYPE_ELEVATION);
    expect(result.records?.[0]?.entityKey).toBe("elevation:40,-3");
  });

  it("should throw PluginInputError for an unknown action", async () => {
    await expect(
      plugin.invoke("nope", makeContext(), ONE_LOCATION),
    ).rejects.toBeInstanceOf(PluginInputError);
  });

  it("should throw PluginInputError for an invalid payload", async () => {
    await expect(
      plugin.invoke(ACTION_LOOKUP, makeContext(), { locations: [] }),
    ).rejects.toBeInstanceOf(PluginInputError);
  });

  it("should map HTTP 400 to PluginInputError", async () => {
    stubFetch({ ok: false, status: 400 });
    await expect(
      plugin.invoke(ACTION_LOOKUP, makeContext(), ONE_LOCATION),
    ).rejects.toBeInstanceOf(PluginInputError);
  });

  it("should map HTTP 429 with Retry-After to RateLimitError", async () => {
    stubFetch({ ok: false, status: 429, headers: { "Retry-After": "30" } });
    await expect(
      plugin.invoke(ACTION_LOOKUP, makeContext(), ONE_LOCATION),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it("should map HTTP 429 without Retry-After to RateLimitError", async () => {
    stubFetch({ ok: false, status: 429 });
    await expect(
      plugin.invoke(ACTION_LOOKUP, makeContext(), ONE_LOCATION),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it("should map other non-OK responses to TransientError", async () => {
    stubFetch({ ok: false, status: 503 });
    await expect(
      plugin.invoke(ACTION_LOOKUP, makeContext(), ONE_LOCATION),
    ).rejects.toBeInstanceOf(TransientError);
  });

  it("should throw when execute() is called on this action-only plugin", () => {
    expect(() => plugin.execute("anything")).toThrow();
  });

  it("should use a configured baseUrl for requests", async () => {
    const fn = stubFetch({ json: { results: [] } });
    plugin.configure({ baseUrl: "https://elev.example.com" });
    await plugin.invoke(ACTION_LOOKUP, makeContext(), ONE_LOCATION);
    expect(fn).toHaveBeenCalledWith(
      "https://elev.example.com/api/v1/lookup",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
