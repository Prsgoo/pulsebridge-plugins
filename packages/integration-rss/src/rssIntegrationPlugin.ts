import type { IntegrationPlugin } from "pulsebridge";

export class RssIntegrationPlugin implements IntegrationPlugin {
  readonly manifest = {
    id: "@prsgoo/integration-rss",
    name: "RSS",
    version: "0.1.0-alpha.1",
    kind: "integration" as const,
    operations: [{ id: "fetch", name: "Fetch", recordType: "news.event" }],
    polling: { defaultIntervalMs: 300_000, minIntervalMs: 60_000 },
  };

  async execute() {
    return [];
  }
}
