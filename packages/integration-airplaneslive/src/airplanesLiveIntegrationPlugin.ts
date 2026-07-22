import type { IntegrationPlugin } from "pulsebridge";

export class AirplanesLiveIntegrationPlugin implements IntegrationPlugin {
  readonly manifest = {
    id: "@prsgoo/integration-airplaneslive",
    name: "airplanes.live",
    version: "0.1.0-alpha.1",
    kind: "integration" as const,
    operations: [{ id: "fetch", name: "Fetch", recordType: "flight.position" }],
    polling: { defaultIntervalMs: 10_000, minIntervalMs: 5_000 },
  };

  async execute() {
    return [];
  }
}
