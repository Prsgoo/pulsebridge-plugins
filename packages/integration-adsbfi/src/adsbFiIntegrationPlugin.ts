import type { IntegrationPlugin } from "pulsebridge";

export class AdsbFiIntegrationPlugin implements IntegrationPlugin {
  readonly manifest = {
    id: "@prsgoo/integration-adsbfi",
    name: "adsb.fi",
    version: "0.1.0-alpha.1",
    kind: "integration" as const,
    operations: [{ id: "fetch", name: "Fetch", recordType: "flight.position" }],
    polling: { defaultIntervalMs: 10_000, minIntervalMs: 5_000 },
  };

  async execute() {
    return [];
  }
}
