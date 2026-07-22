import type { IntegrationPlugin } from "pulsebridge";

export class OpenSkyIntegrationPlugin implements IntegrationPlugin {
  readonly manifest = {
    id: "@prsgoo/integration-opensky",
    name: "OpenSky Network",
    version: "0.1.0-alpha.1",
    kind: "integration" as const,
    operations: [{ id: "fetch", name: "Fetch", recordType: "flight.position" }],
    auth: {
      type: "basic" as const,
      secrets: [
        { key: "OPENSKY_USERNAME", required: false },
        { key: "OPENSKY_PASSWORD", required: false },
      ],
    },
    polling: { defaultIntervalMs: 10_000, minIntervalMs: 5_000 },
  };

  async execute() {
    return [];
  }
}
