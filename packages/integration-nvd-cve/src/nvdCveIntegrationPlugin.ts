import { z } from "zod";
import {
  PluginKinds,
  PluginAuthError,
  RateLimitError,
  TransientError,
  type IntegrationPlugin,
  type IntegrationPluginManifest,
  type PulseRecord,
  type RuntimeContext,
} from "pulsebridge";

export const NVD_INTEGRATION_ID = "@prsgoo/integration-nvd-cve";
export const RECORD_TYPE_CVE = "cve";

const NVD_CVE_URL = "https://services.nvd.nist.gov/rest/json/cves/2.0";
const MAX_CVE_REFERENCES = 5;

export const nvdConfigSchema = z.object({
  lookbackHours: z.number().int().min(1).max(168).default(24),
  severity: z
    .array(z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]))
    .default(["CRITICAL", "HIGH"]),
});

export type NvdConfig = z.infer<typeof nvdConfigSchema>;

export interface CveData {
  /** e.g. "CVE-2024-12345" */
  cveId: string;
  description: string;
  published: string;
  lastModified: string;
  /** "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" */
  severity: string;
  /** CVSS base score 0.0–10.0 */
  baseScore: number;
  /** "3.1" | "3.0" | "2.0" */
  cvssVersion: string;
  /** First 5 reference URLs */
  references: string[];
}

interface NvdCvssMetricV31 {
  cvssData: {
    version: string;
    baseScore: number;
    baseSeverity: string;
  };
}

interface NvdCvssMetricV30 {
  cvssData: {
    version: string;
    baseScore: number;
    baseSeverity: string;
  };
}

interface NvdCvssMetricV2 {
  cvssData: {
    version: string;
    baseScore: number;
  };
  baseSeverity: string;
}

interface NvdCve {
  id: string;
  published: string;
  lastModified: string;
  descriptions: Array<{ lang: string; value: string }>;
  references: Array<{ url: string }>;
  metrics?: {
    cvssMetricV31?: NvdCvssMetricV31[];
    cvssMetricV30?: NvdCvssMetricV30[];
    cvssMetricV2?: NvdCvssMetricV2[];
  };
}

interface NvdCveResponse {
  vulnerabilities: Array<{ cve: NvdCve }>;
}

function extractCvss(
  cve: NvdCve,
): { severity: string; baseScore: number; cvssVersion: string } | null {
  if (cve.metrics?.cvssMetricV31?.[0]) {
    const m = cve.metrics.cvssMetricV31[0];
    return {
      severity: m.cvssData.baseSeverity,
      baseScore: m.cvssData.baseScore,
      cvssVersion: m.cvssData.version,
    };
  }
  if (cve.metrics?.cvssMetricV30?.[0]) {
    const m = cve.metrics.cvssMetricV30[0];
    return {
      severity: m.cvssData.baseSeverity,
      baseScore: m.cvssData.baseScore,
      cvssVersion: m.cvssData.version,
    };
  }
  if (cve.metrics?.cvssMetricV2?.[0]) {
    const m = cve.metrics.cvssMetricV2[0];
    return {
      severity: m.baseSeverity,
      baseScore: m.cvssData.baseScore,
      cvssVersion: m.cvssData.version,
    };
  }
  return null;
}

export class NvdCveIntegrationPlugin implements IntegrationPlugin<NvdConfig> {
  readonly manifest: IntegrationPluginManifest = {
    id: NVD_INTEGRATION_ID,
    name: "NVD CVE",
    version: "0.1.0",
    kind: PluginKinds.INTEGRATION,
    operations: [
      {
        id: "fetch-cves",
        name: "Fetch CVEs",
        recordType: RECORD_TYPE_CVE,
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
      defaultIntervalMs: 60 * 60_000,
      minIntervalMs: 30 * 60_000,
      hard: false,
    },
    rateLimit: {
      requestsPerMinute: 5,
      maxConcurrentRequests: 1,
    },
  };

  readonly configSchema = nvdConfigSchema;

  private config: NvdConfig = nvdConfigSchema.parse({});

  configure(config: NvdConfig): void {
    this.config = config;
  }

  async execute(
    operationId: string,
    context: RuntimeContext,
  ): Promise<ReadonlyArray<PulseRecord<CveData>>> {
    if (operationId !== "fetch-cves") {
      throw new Error(
        `Operation '${operationId}' is not supported by plugin '${this.manifest.id}'.`,
      );
    }

    const now = context.now();
    const pubStartDate = new Date(
      now.getTime() - this.config.lookbackHours * 60 * 60 * 1000,
    ).toISOString();
    const pubEndDate = now.toISOString();

    const apiKey = context.secrets.get("NVD_API_KEY");
    const headers: Record<string, string> = {};
    if (apiKey) {
      headers["apiKey"] = apiKey;
    }

    const query = new URLSearchParams({
      pubStartDate,
      pubEndDate,
      resultsPerPage: "100",
    });
    const response = await fetch(`${NVD_CVE_URL}?${query.toString()}`, {
      headers,
      signal: context.signal ?? null,
    });

    if (response.status === 403) {
      throw new PluginAuthError("NVD API key is invalid.");
    }
    if (response.status === 429) {
      const retryAfter = parseInt(
        response.headers.get("Retry-After") ?? "30",
        10,
      );
      throw new RateLimitError("NVD rate limit reached.", retryAfter * 1000);
    }
    if (response.status === 503) {
      throw new TransientError("NVD API is temporarily unavailable.");
    }
    if (!response.ok) {
      throw new TransientError(`NVD API returned HTTP ${response.status}.`);
    }

    const data = (await response.json()) as NvdCveResponse;
    const recordTimestamp = now.toISOString();

    return data.vulnerabilities.flatMap(({ cve }) => {
      const cvss = extractCvss(cve);
      if (!cvss) return [];
      if (
        !this.config.severity.includes(
          cvss.severity as NvdConfig["severity"][number],
        )
      )
        return [];

      const description =
        cve.descriptions.find((d) => d.lang === "en")?.value ?? "";

      return [
        {
          type: RECORD_TYPE_CVE,
          timestamp: recordTimestamp,
          source: NVD_INTEGRATION_ID,
          entityKey: `nvd:${cve.id}`,
          data: {
            cveId: cve.id,
            description,
            published: cve.published,
            lastModified: cve.lastModified,
            severity: cvss.severity,
            baseScore: cvss.baseScore,
            cvssVersion: cvss.cvssVersion,
            references: cve.references
              .slice(0, MAX_CVE_REFERENCES)
              .map((r) => r.url),
          },
        },
      ];
    });
  }
}
