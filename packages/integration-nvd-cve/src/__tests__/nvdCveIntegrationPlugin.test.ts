import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  PluginAuthError,
  PluginKinds,
  RateLimitError,
  TransientError,
} from "pulsebridge";
import {
  NvdCveIntegrationPlugin,
  RECORD_TYPE_CVE,
  nvdConfigSchema,
} from "../nvdCveIntegrationPlugin.js";

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

function makeCve(
  id: string,
  severity: string,
  score: number,
  version: "v31" | "v30" | "v2",
) {
  const metrics =
    version === "v31"
      ? {
          cvssMetricV31: [
            {
              cvssData: {
                version: "3.1",
                baseScore: score,
                baseSeverity: severity,
              },
            },
          ],
        }
      : version === "v30"
        ? {
            cvssMetricV30: [
              {
                cvssData: {
                  version: "3.0",
                  baseScore: score,
                  baseSeverity: severity,
                },
              },
            ],
          }
        : {
            cvssMetricV2: [
              {
                cvssData: { version: "2.0", baseScore: score },
                baseSeverity: severity,
              },
            ],
          };

  return {
    id,
    published: "2024-01-10T00:00:00Z",
    lastModified: "2024-01-12T00:00:00Z",
    descriptions: [{ lang: "en", value: `Test CVE ${id}` }],
    references: [
      { url: "https://example.com/ref1" },
      { url: "https://example.com/ref2" },
    ],
    metrics,
  };
}

describe("NvdCveIntegrationPlugin", () => {
  let plugin: NvdCveIntegrationPlugin;

  beforeEach(() => {
    plugin = new NvdCveIntegrationPlugin();
    plugin.configure({ lookbackHours: 24, severity: ["CRITICAL", "HIGH"] });
    vi.clearAllMocks();
  });

  it("should return CVE records on successful response", async () => {
    const cve = makeCve("CVE-2024-12345", "CRITICAL", 9.8, "v31");
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse({ vulnerabilities: [{ cve }] }),
    );

    const records = await plugin.execute("fetch-cves", makeContext() as never);

    expect(records).toHaveLength(1);
    expect(records[0]?.type).toBe(RECORD_TYPE_CVE);
    expect(records[0]?.entityKey).toBe("nvd:CVE-2024-12345");
    expect(records[0]?.data.severity).toBe("CRITICAL");
    expect(records[0]?.data.baseScore).toBe(9.8);
    expect(records[0]?.data.cvssVersion).toBe("3.1");
  });

  it("should map every CVE field into the record", async () => {
    const cve = makeCve("CVE-2024-12345", "CRITICAL", 9.8, "v31");
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse({ vulnerabilities: [{ cve }] }),
    );

    const records = await plugin.execute("fetch-cves", makeContext() as never);

    expect(records[0]).toMatchObject({
      type: RECORD_TYPE_CVE,
      source: "@prsgoo/integration-nvd-cve",
      timestamp: "2024-01-15T12:00:00.000Z",
      entityKey: "nvd:CVE-2024-12345",
      data: {
        cveId: "CVE-2024-12345",
        description: "Test CVE CVE-2024-12345",
        published: "2024-01-10T00:00:00Z",
        lastModified: "2024-01-12T00:00:00Z",
        severity: "CRITICAL",
        baseScore: 9.8,
        cvssVersion: "3.1",
        references: ["https://example.com/ref1", "https://example.com/ref2"],
      },
    });
  });

  it("should cap references at the first five", async () => {
    const cve = {
      ...makeCve("CVE-2024-12345", "CRITICAL", 9.8, "v31"),
      references: Array.from({ length: 7 }, (_, i) => ({
        url: `https://example.com/ref${i}`,
      })),
    };
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse({ vulnerabilities: [{ cve }] }),
    );

    const records = await plugin.execute("fetch-cves", makeContext() as never);

    expect(records[0]?.data.references).toHaveLength(5);
  });

  it("should pick the English description when several languages exist", async () => {
    const cve = {
      ...makeCve("CVE-2024-12345", "CRITICAL", 9.8, "v31"),
      descriptions: [
        { lang: "es", value: "descripción en español" },
        { lang: "en", value: "english description" },
      ],
    };
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse({ vulnerabilities: [{ cve }] }),
    );

    const records = await plugin.execute("fetch-cves", makeContext() as never);

    expect(records[0]?.data.description).toBe("english description");
  });

  it("should fall back to an empty description when no English entry exists", async () => {
    const cve = {
      ...makeCve("CVE-2024-12345", "CRITICAL", 9.8, "v31"),
      descriptions: [{ lang: "es", value: "descripción en español" }],
    };
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse({ vulnerabilities: [{ cve }] }),
    );

    const records = await plugin.execute("fetch-cves", makeContext() as never);

    expect(records[0]?.data.description).toBe("");
  });

  it("should send the API key as a header when provided", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeOkResponse({ vulnerabilities: [] }));

    await plugin.execute(
      "fetch-cves",
      makeContext({ NVD_API_KEY: TEST_KEY }) as never,
    );

    const headers = fetchSpy.mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >;
    expect(headers["apiKey"]).toBe(TEST_KEY);
  });

  it("should query the NVD CVE endpoint with a 100-result page size", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeOkResponse({ vulnerabilities: [] }));

    await plugin.execute("fetch-cves", makeContext() as never);

    const url = new URL(fetchSpy.mock.calls[0]?.[0] as string);
    expect(url.origin + url.pathname).toBe(
      "https://services.nvd.nist.gov/rest/json/cves/2.0",
    );
    expect(url.searchParams.get("resultsPerPage")).toBe("100");
  });

  it("should query NVD with both pubStartDate and pubEndDate", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeOkResponse({ vulnerabilities: [] }));

    await plugin.execute("fetch-cves", makeContext() as never);

    const requestedUrl = new URL(fetchSpy.mock.calls[0]?.[0] as string);
    expect(requestedUrl.searchParams.get("pubStartDate")).toBe(
      "2024-01-14T12:00:00.000Z",
    );
    expect(requestedUrl.searchParams.get("pubEndDate")).toBe(
      "2024-01-15T12:00:00.000Z",
    );
  });

  it("should derive pubStartDate from a reconfigured lookback window", async () => {
    plugin.configure({ lookbackHours: 1, severity: ["CRITICAL", "HIGH"] });
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeOkResponse({ vulnerabilities: [] }));

    await plugin.execute("fetch-cves", makeContext() as never);

    const requestedUrl = new URL(fetchSpy.mock.calls[0]?.[0] as string);
    expect(requestedUrl.searchParams.get("pubStartDate")).toBe(
      "2024-01-15T11:00:00.000Z",
    );
  });

  it("should forward the abort signal to fetch", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeOkResponse({ vulnerabilities: [] }));
    const controller = new AbortController();

    await plugin.execute(
      "fetch-cves",
      makeContext({}, controller.signal) as never,
    );

    expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it("should pass a null signal when context has none", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeOkResponse({ vulnerabilities: [] }));

    await plugin.execute("fetch-cves", makeContext() as never);

    expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBeNull();
  });

  it("should filter out CVEs below configured severity", async () => {
    const critical = makeCve("CVE-2024-00001", "CRITICAL", 9.8, "v31");
    const medium = makeCve("CVE-2024-00002", "MEDIUM", 5.3, "v31");
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse({ vulnerabilities: [{ cve: critical }, { cve: medium }] }),
    );

    const records = await plugin.execute("fetch-cves", makeContext() as never);

    expect(records).toHaveLength(1);
    expect(records[0]?.data.cveId).toBe("CVE-2024-00001");
  });

  it("should skip CVEs with no CVSS metrics", async () => {
    const noMetrics = {
      ...makeCve("CVE-2024-99999", "CRITICAL", 9.8, "v31"),
      metrics: {},
    };
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse({ vulnerabilities: [{ cve: noMetrics }] }),
    );

    const records = await plugin.execute("fetch-cves", makeContext() as never);

    expect(records).toHaveLength(0);
  });

  it("should prefer v3.1 CVSS over v3.0 and v2.0", async () => {
    const cve = {
      ...makeCve("CVE-2024-11111", "CRITICAL", 9.8, "v31"),
      metrics: {
        cvssMetricV31: [
          {
            cvssData: {
              version: "3.1",
              baseScore: 9.8,
              baseSeverity: "CRITICAL",
            },
          },
        ],
        cvssMetricV30: [
          {
            cvssData: { version: "3.0", baseScore: 8.5, baseSeverity: "HIGH" },
          },
        ],
      },
    };
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse({ vulnerabilities: [{ cve }] }),
    );

    const records = await plugin.execute("fetch-cves", makeContext() as never);

    expect(records[0]?.data.cvssVersion).toBe("3.1");
    expect(records[0]?.data.baseScore).toBe(9.8);
  });

  it("should use v3.0 CVSS when v3.1 is absent", async () => {
    const cve = makeCve("CVE-2024-33333", "CRITICAL", 9.1, "v30");
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse({ vulnerabilities: [{ cve }] }),
    );

    const records = await plugin.execute("fetch-cves", makeContext() as never);

    expect(records[0]?.data.cvssVersion).toBe("3.0");
    expect(records[0]?.data.baseScore).toBe(9.1);
  });

  it("should use v2.0 severity as fallback", async () => {
    const cve = makeCve("CVE-2024-22222", "HIGH", 7.5, "v2");
    plugin.configure({ lookbackHours: 24, severity: ["HIGH"] });
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse({ vulnerabilities: [{ cve }] }),
    );

    const records = await plugin.execute("fetch-cves", makeContext() as never);

    expect(records[0]?.data.cvssVersion).toBe("2.0");
  });

  it("should work without an API key (optional)", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse({ vulnerabilities: [] }),
    );

    const records = await plugin.execute("fetch-cves", makeContext() as never);

    expect(records).toHaveLength(0);
  });

  it("should throw PluginAuthError on 403", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(403));

    await expect(
      plugin.execute("fetch-cves", makeContext() as never),
    ).rejects.toBeInstanceOf(PluginAuthError);
  });

  it("should describe an invalid key on 403", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(403));

    await expect(
      plugin.execute("fetch-cves", makeContext() as never),
    ).rejects.toThrow(/invalid/i);
  });

  it("should throw RateLimitError on 429 with Retry-After header", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeErrorResponse(429, { "Retry-After": "30" }),
    );

    await expect(
      plugin.execute("fetch-cves", makeContext() as never),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it("should derive the retry delay from the Retry-After header", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeErrorResponse(429, { "Retry-After": "60" }),
    );

    await expect(
      plugin.execute("fetch-cves", makeContext() as never),
    ).rejects.toMatchObject({ retryAfterMs: 60_000 });
  });

  it("should default the retry delay to 30s when no header is present", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(429));

    await expect(
      plugin.execute("fetch-cves", makeContext() as never),
    ).rejects.toMatchObject({ retryAfterMs: 30_000 });
  });

  it("should mention the rate limit in the 429 error message", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(429));

    await expect(
      plugin.execute("fetch-cves", makeContext() as never),
    ).rejects.toThrow(/rate limit/i);
  });

  it("should throw TransientError on 503", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(503));

    await expect(
      plugin.execute("fetch-cves", makeContext() as never),
    ).rejects.toBeInstanceOf(TransientError);
  });

  it("should describe a temporary outage on 503", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(503));

    await expect(
      plugin.execute("fetch-cves", makeContext() as never),
    ).rejects.toThrow(/temporarily unavailable/i);
  });

  it("should include the status code for other non-ok responses", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(500));

    await expect(
      plugin.execute("fetch-cves", makeContext() as never),
    ).rejects.toThrow(/HTTP 500/);
  });

  it("should throw on unsupported operationId", async () => {
    await expect(
      plugin.execute("unknown-op", makeContext() as never),
    ).rejects.toThrow("not supported");
  });

  it("should expose the expected manifest", () => {
    expect(plugin.manifest).toEqual({
      id: "@prsgoo/integration-nvd-cve",
      name: "NVD CVE",
      version: "0.1.0",
      kind: PluginKinds.INTEGRATION,
      operations: [
        {
          id: "fetch-cves",
          name: "Fetch CVEs",
          recordType: "cve",
        },
      ],
      auth: {
        type: "apiKey",
        secrets: [
          {
            key: "NVD_API_KEY",
            required: false,
            description:
              "Optional — improves rate limit from 5 to 50 requests per 30 seconds",
          },
        ],
      },
      polling: {
        defaultIntervalMs: 3_600_000,
        minIntervalMs: 1_800_000,
        hard: false,
      },
      rateLimit: { requestsPerMinute: 5, maxConcurrentRequests: 1 },
    });
  });

  it("should default the lookback window to 24 hours", () => {
    expect(nvdConfigSchema.parse({}).lookbackHours).toBe(24);
  });

  it("should default severity to CRITICAL and HIGH", () => {
    expect(nvdConfigSchema.parse({}).severity).toEqual(["CRITICAL", "HIGH"]);
  });

  it("should reject a lookback window below 1 hour", () => {
    expect(() => nvdConfigSchema.parse({ lookbackHours: 0 })).toThrow();
  });

  it("should reject a lookback window above 168 hours", () => {
    expect(() => nvdConfigSchema.parse({ lookbackHours: 169 })).toThrow();
  });

  it("should reject an unknown severity value", () => {
    expect(() => nvdConfigSchema.parse({ severity: ["SEVERE"] })).toThrow();
  });
});
