import { describe, it, expect } from "vitest";
import { NasaFirmsIntegrationPlugin } from "../nasaFirmsIntegrationPlugin.js";

describe("NasaFirmsIntegrationPlugin", () => {
  it("should expose the correct manifest id", () => {
    const plugin = new NasaFirmsIntegrationPlugin();
    expect(plugin.manifest.id).toBe("@prsgoo/integration-nasa-firms");
  });

  it("should return an empty array from execute", async () => {
    const plugin = new NasaFirmsIntegrationPlugin();
    expect(await plugin.execute()).toEqual([]);
  });
});
