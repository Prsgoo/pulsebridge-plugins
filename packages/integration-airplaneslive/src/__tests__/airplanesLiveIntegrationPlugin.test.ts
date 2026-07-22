import { describe, it, expect } from "vitest";
import { AirplanesLiveIntegrationPlugin } from "../airplanesLiveIntegrationPlugin.js";

describe("AirplanesLiveIntegrationPlugin", () => {
  it("should expose the correct manifest id", () => {
    const plugin = new AirplanesLiveIntegrationPlugin();
    expect(plugin.manifest.id).toBe("@prsgoo/integration-airplaneslive");
  });

  it("should return an empty array from execute", async () => {
    const plugin = new AirplanesLiveIntegrationPlugin();
    expect(await plugin.execute()).toEqual([]);
  });
});
