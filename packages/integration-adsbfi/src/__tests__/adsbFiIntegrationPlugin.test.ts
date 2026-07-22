import { describe, it, expect } from "vitest";
import { AdsbFiIntegrationPlugin } from "../adsbFiIntegrationPlugin.js";

describe("AdsbFiIntegrationPlugin", () => {
  it("should expose the correct manifest id", () => {
    const plugin = new AdsbFiIntegrationPlugin();
    expect(plugin.manifest.id).toBe("@prsgoo/integration-adsbfi");
  });

  it("should return an empty array from execute", async () => {
    const plugin = new AdsbFiIntegrationPlugin();
    expect(await plugin.execute()).toEqual([]);
  });
});
