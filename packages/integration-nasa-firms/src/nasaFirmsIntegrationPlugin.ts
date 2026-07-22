import type { IntegrationPlugin } from "pulsebridge";

export class NasaFirmsIntegrationPlugin implements IntegrationPlugin {
  readonly manifest = {
    id: "@prsgoo/integration-nasa-firms",
    name: "NASA FIRMS",
    version: "0.1.0-alpha.1",
    kind: "integration" as const,
    operations: [{ id: "fetch", name: "Fetch", recordType: "wildfire.event" }],
    auth: {
      type: "apiKey" as const,
      secrets: [{ key: "FIRMS_MAP_KEY", required: true }],
    },
    polling: { defaultIntervalMs: 60_000, minIntervalMs: 30_000 },
  };

  async execute() {
    return [];
  }
}
