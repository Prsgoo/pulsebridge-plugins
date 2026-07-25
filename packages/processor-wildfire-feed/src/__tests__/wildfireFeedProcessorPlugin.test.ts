import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PulseRecord, RuntimeContext } from "pulsebridge";
import {
  WildfireFeedProcessorPlugin,
  WILDFIRE_FEED_PROCESSOR_ID,
  VIEW_WILDFIRE_FEED,
} from "../wildfireFeedProcessorPlugin.js";
import { PluginKinds } from "pulsebridge";

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function makeContext(): RuntimeContext {
  return {
    logger: mockLogger,
    now: () => new Date("2024-06-01T00:00:00Z"),
    secrets: { get: () => undefined, has: () => false },
  } as unknown as RuntimeContext;
}

function makeWildfireRecord(
  entityKey: string,
  frp: number,
  opts: Partial<{
    timestamp: string;
    latitude: number;
    longitude: number;
    brightness: number;
    confidence: string;
    instrument: string;
    acquisitionDate: string;
    acquisitionTime: string;
    satellite: string;
  }> = {},
): PulseRecord {
  return {
    type: "wildfire.event",
    timestamp: opts.timestamp ?? "2024-06-01T00:00:00Z",
    source: "@prsgoo/integration-nasa-firms",
    entityKey,
    data: {
      latitude: opts.latitude ?? 34.05,
      longitude: opts.longitude ?? -118.24,
      brightness: opts.brightness ?? 320.5,
      frp,
      confidence: opts.confidence ?? "high",
      instrument: opts.instrument ?? "MODIS",
      acquisitionDate: opts.acquisitionDate ?? "2024-06-01",
      acquisitionTime: opts.acquisitionTime ?? "0009",
      satellite: opts.satellite ?? "Terra",
    },
  };
}

describe("WildfireFeedProcessorPlugin", () => {
  let plugin: WildfireFeedProcessorPlugin;

  beforeEach(() => {
    plugin = new WildfireFeedProcessorPlugin();
    vi.clearAllMocks();
  });

  it("should produce a wildfire-feed view from wildfire.event records", async () => {
    const view = await plugin.process(
      [makeWildfireRecord("firms:34.05,-118.24,2024-06-01,0009", 45.2)],
      makeContext(),
    );
    expect(view).not.toBeNull();
    expect(view?.view).toBe(VIEW_WILDFIRE_FEED);
    expect(view?.items).toHaveLength(1);
  });

  it("should sort by frp descending", async () => {
    const records = [
      makeWildfireRecord("firms:a", 10.0),
      makeWildfireRecord("firms:b", 99.5),
      makeWildfireRecord("firms:c", 45.2),
    ];
    const view = await plugin.process(records, makeContext());
    expect(view?.items.map((i) => i.frp)).toEqual([99.5, 45.2, 10.0]);
  });

  it("should deduplicate by entityKey keeping the latest record", async () => {
    const older = {
      ...makeWildfireRecord("firms:a", 10.0),
      timestamp: "2024-06-01T10:00:00Z",
    };
    const newer = {
      ...makeWildfireRecord("firms:a", 88.8),
      timestamp: "2024-06-01T11:00:00Z",
    };
    const view = await plugin.process([older, newer], makeContext());
    expect(view?.items).toHaveLength(1);
    expect(view?.items[0]?.frp).toBe(88.8);
  });

  it("should keep newer when older arrives after it in same batch", async () => {
    const newer = {
      ...makeWildfireRecord("firms:a", 88.8),
      timestamp: "2024-06-01T11:00:00Z",
    };
    const older = {
      ...makeWildfireRecord("firms:a", 10.0),
      timestamp: "2024-06-01T10:00:00Z",
    };
    const view = await plugin.process([newer, older], makeContext());
    expect(view?.items).toHaveLength(1);
    expect(view?.items[0]?.frp).toBe(88.8);
  });

  it("should return null when records array is empty", async () => {
    const view = await plugin.process([], makeContext());
    expect(view).toBeNull();
  });

  it("should return null when no wildfire.event records are present", async () => {
    const unrelated: PulseRecord = {
      type: "seismic.event",
      timestamp: "2024-06-01T00:00:00Z",
      source: "other",
      data: {},
    };
    const view = await plugin.process([unrelated], makeContext());
    expect(view).toBeNull();
  });

  it("should map all WildfireFeedItem fields correctly", async () => {
    const record = makeWildfireRecord(
      "firms:34.05,-118.24,2024-06-01,0009",
      55.5,
      {
        timestamp: "2024-06-01T06:30:00Z",
        latitude: 34.05,
        longitude: -118.24,
        brightness: 325.8,
        confidence: "nominal",
        instrument: "VIIRS",
        acquisitionDate: "2024-06-01",
        acquisitionTime: "0009",
        satellite: "Suomi-NPP",
      },
    );
    record.timestamp = "2024-06-01T06:30:00Z";

    const view = await plugin.process([record], makeContext());
    const item = view?.items[0];

    expect(item?.id).toBe("firms:34.05,-118.24,2024-06-01,0009");
    expect(item?.latitude).toBe(34.05);
    expect(item?.longitude).toBe(-118.24);
    expect(item?.brightness).toBe(325.8);
    expect(item?.frp).toBe(55.5);
    expect(item?.confidence).toBe("nominal");
    expect(item?.instrument).toBe("VIIRS");
    expect(item?.acquisitionDate).toBe("2024-06-01");
    expect(item?.acquisitionTime).toBe("0009");
    expect(item?.satellite).toBe("Suomi-NPP");
    expect(item?.updatedAt).toBe("2024-06-01T06:30:00Z");
  });

  it("should set view field to wildfire-feed", async () => {
    const view = await plugin.process(
      [makeWildfireRecord("firms:a", 20.0)],
      makeContext(),
    );
    expect(view?.view).toBe("wildfire-feed");
  });

  it("should set generatedAt to context.now() ISO string", async () => {
    const view = await plugin.process(
      [makeWildfireRecord("firms:a", 20.0)],
      makeContext(),
    );
    expect(view?.generatedAt).toBe("2024-06-01T00:00:00.000Z");
  });

  it("should log debug when no wildfire records are present", async () => {
    await plugin.process([], makeContext());
    expect(mockLogger.debug).toHaveBeenCalledWith(
      "No wildfire records to process.",
      { pluginId: WILDFIRE_FEED_PROCESSOR_ID },
    );
  });

  describe("manifest", () => {
    it("should have the correct id", () => {
      expect(plugin.manifest.id).toBe("@prsgoo/processor-wildfire-feed");
    });

    it("should have PROCESSOR kind", () => {
      expect(plugin.manifest.kind).toBe(PluginKinds.PROCESSOR);
    });

    it("should consume wildfire.event", () => {
      expect(plugin.manifest.consumes).toContain("wildfire.event");
    });

    it("should produce wildfire-feed", () => {
      expect(plugin.manifest.produces).toContain("wildfire-feed");
    });
  });
});
