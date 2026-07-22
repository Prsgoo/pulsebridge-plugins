import { describe, it, expect } from "vitest";
import { OpenSkyIntegrationPlugin } from "../openSkyIntegrationPlugin.js";

describe("OpenSkyIntegrationPlugin", () => {
  it("should expose the correct manifest id", () => {
    const plugin = new OpenSkyIntegrationPlugin();
    expect(plugin.manifest.id).toBe("@prsgoo/integration-opensky");
  });

  it("should return an empty array from execute", async () => {
    const plugin = new OpenSkyIntegrationPlugin();
    expect(await plugin.execute()).toEqual([]);
  });
});
