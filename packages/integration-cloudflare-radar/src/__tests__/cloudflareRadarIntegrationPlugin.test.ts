import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  PluginAuthError,
  PluginKinds,
  RateLimitError,
  TransientError,
} from "pulsebridge";
import {
  CloudflareRadarIntegrationPlugin,
  RECORD_TYPE_INTERNET_ANOMALY,
  cloudflareRadarConfigSchema,
} from "../cloudflareRadarIntegrationPlugin.js";

const TEST_KEY = "demo-value";
const withKey = { CLOUDFLARE_RADAR_TOKEN: TEST_KEY };

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

function makeOkResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    headers: { get: () => null },
  } as unknown as Response;
}

function makeErrorResponse(status: number) {
  return {
    ok: false,
    status,
    json: () => Promise.resolve({}),
    headers: { get: () => null },
  } as unknown as Response;
}

const trafficAnomaly = {
  uuid: "abc-123",
  type: "LOCATION",
  startDate: "2024-01-15T08:00:00Z",
  endDate: "2024-01-15T09:00:00Z",
  status: "UNVERIFIED",
  locationDetails: { code: "US", name: "United States" },
  asnDetails: null,
};

const bgpHijackEvent = {
  id: 42,
  min_hijack_ts: "2024-01-15T06:00:00Z",
  max_hijack_ts: "2024-01-15T07:00:00Z",
  hijacker_asn: 12345,
};

const trafficBody = { result: { trafficAnomalies: [trafficAnomaly] } };
const bgpBody = {
  result: {
    events: [bgpHijackEvent],
    asn_info: [{ asn: 12345, org_name: "Evil Corp AS" }],
  },
};

describe("CloudflareRadarIntegrationPlugin", () => {
  let plugin: CloudflareRadarIntegrationPlugin;

  beforeEach(() => {
    plugin = new CloudflareRadarIntegrationPlugin();
    plugin.configure({});
    vi.clearAllMocks();
  });

  it("should send the bearer token and JSON content type headers", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeOkResponse(trafficBody));

    await plugin.execute(
      "fetch-traffic-anomalies",
      makeContext(withKey) as never,
    );

    const headers = fetchSpy.mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >;
    expect(headers.Authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("should throw PluginAuthError when token is missing", async () => {
    await expect(
      plugin.execute("fetch-traffic-anomalies", makeContext() as never),
    ).rejects.toBeInstanceOf(PluginAuthError);
  });

  it("should name the missing secret in the auth error", async () => {
    await expect(
      plugin.execute("fetch-traffic-anomalies", makeContext() as never),
    ).rejects.toThrow(/CLOUDFLARE_RADAR_TOKEN/);
  });

  it("should throw on unsupported operationId", async () => {
    await expect(
      plugin.execute("unknown-op", makeContext(withKey) as never),
    ).rejects.toThrow("not supported");
  });

  describe("fetch-traffic-anomalies", () => {
    it("should return traffic anomaly records", async () => {
      vi.spyOn(global, "fetch").mockResolvedValueOnce(
        makeOkResponse(trafficBody),
      );

      const records = await plugin.execute(
        "fetch-traffic-anomalies",
        makeContext(withKey) as never,
      );

      expect(records).toHaveLength(1);
      expect(records[0]?.type).toBe(RECORD_TYPE_INTERNET_ANOMALY);
      expect(records[0]?.entityKey).toBe("cfradar:traffic:abc-123");
      expect(records[0]?.data.anomalyType).toBe("traffic");
      expect(records[0]?.data.startDate).toBe("2024-01-15T08:00:00Z");
      expect(records[0]?.data.endDate).toBe("2024-01-15T09:00:00Z");
      expect(records[0]?.data.location).toBe("United States");
    });

    it("should map every traffic anomaly field into the record", async () => {
      vi.spyOn(global, "fetch").mockResolvedValueOnce(
        makeOkResponse(trafficBody),
      );

      const records = await plugin.execute(
        "fetch-traffic-anomalies",
        makeContext(withKey) as never,
      );

      expect(records[0]).toMatchObject({
        type: RECORD_TYPE_INTERNET_ANOMALY,
        source: "@prsgoo/integration-cloudflare-radar",
        timestamp: "2024-01-15T12:00:00.000Z",
        entityKey: "cfradar:traffic:abc-123",
        data: {
          anomalyType: "traffic",
          startDate: "2024-01-15T08:00:00Z",
          endDate: "2024-01-15T09:00:00Z",
          status: "UNVERIFIED",
          location: "United States",
        },
      });
    });

    it("should map ASN details when the anomaly is AS-scoped", async () => {
      const asnAnomaly = {
        uuid: "as-1",
        type: "AS",
        startDate: "2024-01-15T08:00:00Z",
        status: "UNVERIFIED",
        locationDetails: null,
        asnDetails: { asn: "50810", name: "Mobinnet-AS" },
      };
      vi.spyOn(global, "fetch").mockResolvedValueOnce(
        makeOkResponse({ result: { trafficAnomalies: [asnAnomaly] } }),
      );

      const records = await plugin.execute(
        "fetch-traffic-anomalies",
        makeContext(withKey) as never,
      );

      expect(records[0]?.data.asn).toBe(50810);
      expect(records[0]?.data.asnName).toBe("Mobinnet-AS");
    });

    it("should request the traffic anomalies endpoint with the default query", async () => {
      const fetchSpy = vi
        .spyOn(global, "fetch")
        .mockResolvedValueOnce(makeOkResponse(trafficBody));

      await plugin.execute(
        "fetch-traffic-anomalies",
        makeContext(withKey) as never,
      );

      const url = new URL(String(fetchSpy.mock.calls[0]?.[0]));
      expect(url.origin + url.pathname).toBe(
        "https://api.cloudflare.com/client/v4/radar/traffic_anomalies",
      );
      expect(url.searchParams.get("limit")).toBe("100");
      expect(url.searchParams.get("dateRange")).toBe("7d");
      expect(url.searchParams.get("format")).toBe("JSON");
      expect(url.searchParams.has("location")).toBe(false);
    });

    it("should use a configured dateRange instead of the default", async () => {
      plugin.configure({ dateRange: "28d" });
      const fetchSpy = vi
        .spyOn(global, "fetch")
        .mockResolvedValueOnce(makeOkResponse(trafficBody));

      await plugin.execute(
        "fetch-traffic-anomalies",
        makeContext(withKey) as never,
      );

      const url = new URL(String(fetchSpy.mock.calls[0]?.[0]));
      expect(url.searchParams.get("dateRange")).toBe("28d");
    });

    it("should append the location filter when configured", async () => {
      plugin.configure({ location: "US" });
      const fetchSpy = vi
        .spyOn(global, "fetch")
        .mockResolvedValueOnce(makeOkResponse(trafficBody));

      await plugin.execute(
        "fetch-traffic-anomalies",
        makeContext(withKey) as never,
      );

      const url = new URL(String(fetchSpy.mock.calls[0]?.[0]));
      expect(url.searchParams.get("location")).toBe("US");
    });

    it("should forward the abort signal to fetch", async () => {
      const fetchSpy = vi
        .spyOn(global, "fetch")
        .mockResolvedValueOnce(makeOkResponse(trafficBody));
      const controller = new AbortController();

      await plugin.execute(
        "fetch-traffic-anomalies",
        makeContext(withKey, controller.signal) as never,
      );

      expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
    });

    it("should pass a null signal when context has none", async () => {
      const fetchSpy = vi
        .spyOn(global, "fetch")
        .mockResolvedValueOnce(makeOkResponse(trafficBody));

      await plugin.execute(
        "fetch-traffic-anomalies",
        makeContext(withKey) as never,
      );

      expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBeNull();
    });

    it("should omit optional fields when absent", async () => {
      const minimalAnomaly = {
        uuid: "xyz-999",
        type: "LOCATION",
        startDate: "2024-01-15T08:00:00Z",
        status: "UNVERIFIED",
        endDate: null,
        locationDetails: null,
        asnDetails: null,
      };
      vi.spyOn(global, "fetch").mockResolvedValueOnce(
        makeOkResponse({ result: { trafficAnomalies: [minimalAnomaly] } }),
      );

      const records = await plugin.execute(
        "fetch-traffic-anomalies",
        makeContext(withKey) as never,
      );

      const keys = Object.keys(records[0]?.data ?? {});
      expect(keys).not.toContain("endDate");
      expect(keys).not.toContain("location");
      expect(keys).not.toContain("asn");
    });

    it("should throw PluginAuthError on 401", async () => {
      vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(401));

      await expect(
        plugin.execute(
          "fetch-traffic-anomalies",
          makeContext(withKey) as never,
        ),
      ).rejects.toBeInstanceOf(PluginAuthError);
    });

    it("should throw PluginAuthError on 403", async () => {
      vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(403));

      await expect(
        plugin.execute(
          "fetch-traffic-anomalies",
          makeContext(withKey) as never,
        ),
      ).rejects.toThrow(/invalid/i);
    });

    it("should throw RateLimitError on 429", async () => {
      vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(429));

      await expect(
        plugin.execute(
          "fetch-traffic-anomalies",
          makeContext(withKey) as never,
        ),
      ).rejects.toBeInstanceOf(RateLimitError);
    });

    it("should report a 60s retry delay on 429", async () => {
      vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(429));

      await expect(
        plugin.execute(
          "fetch-traffic-anomalies",
          makeContext(withKey) as never,
        ),
      ).rejects.toMatchObject({ retryAfterMs: 60_000 });
    });

    it("should include the status code in the transient error message", async () => {
      vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(500));

      await expect(
        plugin.execute(
          "fetch-traffic-anomalies",
          makeContext(withKey) as never,
        ),
      ).rejects.toThrow(/HTTP 500/);
    });
  });

  describe("fetch-bgp-hijacks", () => {
    it("should return BGP hijack records", async () => {
      vi.spyOn(global, "fetch").mockResolvedValueOnce(makeOkResponse(bgpBody));

      const records = await plugin.execute(
        "fetch-bgp-hijacks",
        makeContext(withKey) as never,
      );

      expect(records).toHaveLength(1);
      expect(records[0]?.entityKey).toBe("cfradar:bgp:42");
      expect(records[0]?.data.anomalyType).toBe("bgp_hijack");
      expect(records[0]?.data.asn).toBe(12345);
      expect(records[0]?.data.asnName).toBe("Evil Corp AS");
    });

    it("should map every BGP hijack field into the record", async () => {
      vi.spyOn(global, "fetch").mockResolvedValueOnce(makeOkResponse(bgpBody));

      const records = await plugin.execute(
        "fetch-bgp-hijacks",
        makeContext(withKey) as never,
      );

      expect(records[0]).toMatchObject({
        type: RECORD_TYPE_INTERNET_ANOMALY,
        source: "@prsgoo/integration-cloudflare-radar",
        timestamp: "2024-01-15T12:00:00.000Z",
        entityKey: "cfradar:bgp:42",
        data: {
          anomalyType: "bgp_hijack",
          startDate: "2024-01-15T06:00:00Z",
          endDate: "2024-01-15T07:00:00Z",
          asn: 12345,
          asnName: "Evil Corp AS",
        },
      });
    });

    it("should request the BGP hijacks endpoint with the default query", async () => {
      const fetchSpy = vi
        .spyOn(global, "fetch")
        .mockResolvedValueOnce(makeOkResponse(bgpBody));

      await plugin.execute("fetch-bgp-hijacks", makeContext(withKey) as never);

      const url = new URL(String(fetchSpy.mock.calls[0]?.[0]));
      expect(url.origin + url.pathname).toBe(
        "https://api.cloudflare.com/client/v4/radar/bgp/hijacks/events",
      );
      expect(url.searchParams.get("limit")).toBe("100");
      expect(url.searchParams.get("dateRange")).toBe("7d");
      expect(url.searchParams.get("format")).toBe("JSON");
      expect(url.searchParams.has("involvedCountry")).toBe(false);
    });

    it("should append the involvedCountry filter when configured", async () => {
      plugin.configure({ location: "US" });
      const fetchSpy = vi
        .spyOn(global, "fetch")
        .mockResolvedValueOnce(makeOkResponse(bgpBody));

      await plugin.execute("fetch-bgp-hijacks", makeContext(withKey) as never);

      const url = new URL(String(fetchSpy.mock.calls[0]?.[0]));
      expect(url.searchParams.get("involvedCountry")).toBe("US");
    });

    it("should forward the abort signal to fetch", async () => {
      const fetchSpy = vi
        .spyOn(global, "fetch")
        .mockResolvedValueOnce(makeOkResponse(bgpBody));
      const controller = new AbortController();

      await plugin.execute(
        "fetch-bgp-hijacks",
        makeContext(withKey, controller.signal) as never,
      );

      expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
    });

    it("should omit optional fields when absent", async () => {
      const minimalEvent = {
        id: 7,
        min_hijack_ts: "2024-01-15T06:00:00Z",
        max_hijack_ts: null,
        hijacker_asn: 999,
      };
      vi.spyOn(global, "fetch").mockResolvedValueOnce(
        makeOkResponse({ result: { events: [minimalEvent], asn_info: [] } }),
      );

      const records = await plugin.execute(
        "fetch-bgp-hijacks",
        makeContext(withKey) as never,
      );

      const keys = Object.keys(records[0]?.data ?? {});
      expect(keys).not.toContain("endDate");
      expect(keys).not.toContain("asnName");
    });

    it("should throw PluginAuthError on 401", async () => {
      vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(401));

      await expect(
        plugin.execute("fetch-bgp-hijacks", makeContext(withKey) as never),
      ).rejects.toBeInstanceOf(PluginAuthError);
    });

    it("should throw PluginAuthError on 403", async () => {
      vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(403));

      await expect(
        plugin.execute("fetch-bgp-hijacks", makeContext(withKey) as never),
      ).rejects.toThrow(/invalid/i);
    });

    it("should throw RateLimitError on 429", async () => {
      vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(429));

      await expect(
        plugin.execute("fetch-bgp-hijacks", makeContext(withKey) as never),
      ).rejects.toMatchObject({ retryAfterMs: 60_000 });
    });

    it("should throw TransientError on 500", async () => {
      vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(500));

      await expect(
        plugin.execute("fetch-bgp-hijacks", makeContext(withKey) as never),
      ).rejects.toBeInstanceOf(TransientError);
    });

    it("should include the status code in the transient error message", async () => {
      vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(503));

      await expect(
        plugin.execute("fetch-bgp-hijacks", makeContext(withKey) as never),
      ).rejects.toThrow(/HTTP 503/);
    });
  });

  it("should expose the expected manifest", () => {
    expect(plugin.manifest).toEqual({
      id: "@prsgoo/integration-cloudflare-radar",
      name: "Cloudflare Radar",
      version: "0.1.0",
      kind: PluginKinds.INTEGRATION,
      operations: [
        {
          id: "fetch-traffic-anomalies",
          name: "Fetch Traffic Anomalies",
          recordType: "internet.anomaly",
        },
        {
          id: "fetch-bgp-hijacks",
          name: "Fetch BGP Hijacks",
          recordType: "internet.anomaly",
        },
      ],
      auth: {
        type: "bearerToken",
        secrets: [{ key: "CLOUDFLARE_RADAR_TOKEN", required: true }],
      },
      polling: {
        defaultIntervalMs: 900_000,
        minIntervalMs: 300_000,
        hard: false,
      },
      rateLimit: { requestsPerMinute: 60, maxConcurrentRequests: 1 },
    });
  });

  it("should accept an optional location filter", () => {
    expect(cloudflareRadarConfigSchema.parse({ location: "US" }).location).toBe(
      "US",
    );
  });

  it("should leave the location undefined when omitted", () => {
    expect(cloudflareRadarConfigSchema.parse({}).location).toBeUndefined();
  });

  it("should leave dateRange undefined when omitted", () => {
    expect(cloudflareRadarConfigSchema.parse({}).dateRange).toBeUndefined();
  });

  it("should default the request window to 7d when dateRange is unset", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeOkResponse(trafficBody));

    await plugin.execute(
      "fetch-traffic-anomalies",
      makeContext(withKey) as never,
    );

    const url = new URL(String(fetchSpy.mock.calls[0]?.[0]));
    expect(url.searchParams.get("dateRange")).toBe("7d");
  });

  it("should reject a malformed dateRange", () => {
    expect(() =>
      cloudflareRadarConfigSchema.parse({ dateRange: "1week" }),
    ).toThrow();
  });
});
