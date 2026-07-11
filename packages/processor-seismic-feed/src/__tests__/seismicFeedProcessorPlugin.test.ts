import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PulseRecord, RuntimeContext } from "pulsebridge";
import {
  SeismicFeedProcessorPlugin,
  VIEW_SEISMIC_FEED,
} from "../seismicFeedProcessorPlugin.js";

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function makeContext(): RuntimeContext {
  return {
    logger: mockLogger,
    now: () => new Date("2024-01-15T12:00:00Z"),
    secrets: { get: () => undefined, has: () => false },
  } as unknown as RuntimeContext;
}

function makeSeismicRecord(
  id: string,
  magnitude: number,
  place = "Somewhere",
): PulseRecord {
  return {
    type: "seismic.event",
    timestamp: "2024-01-15T11:00:00Z",
    source: "@pulsebridge/integration-usgs-earthquakes",
    entityKey: id,
    data: {
      magnitude,
      magnitudeType: "mw",
      place,
      depth: 10,
      latitude: 35.6,
      longitude: 139.7,
      significance: 500,
      tsunami: false,
      alert: null,
      url: "https://earthquake.usgs.gov/event",
      eventTime: "2024-01-15T10:55:00Z",
    },
  };
}

describe("SeismicFeedProcessorPlugin", () => {
  let plugin: SeismicFeedProcessorPlugin;

  beforeEach(() => {
    plugin = new SeismicFeedProcessorPlugin();
    vi.clearAllMocks();
  });

  it("should produce a seismic-feed view from seismic records", async () => {
    const view = await plugin.process(
      [makeSeismicRecord("us-a", 4.2, "Tokyo")],
      makeContext(),
    );
    expect(view).not.toBeNull();
    expect(view?.view).toBe(VIEW_SEISMIC_FEED);
    expect(view?.items).toHaveLength(1);
    expect(view?.items[0]?.place).toBe("Tokyo");
  });

  it("should sort events by magnitude descending", async () => {
    const records = [
      makeSeismicRecord("us-a", 3.1),
      makeSeismicRecord("us-b", 6.4),
      makeSeismicRecord("us-c", 4.8),
    ];
    const view = await plugin.process(records, makeContext());
    expect(view?.items.map((i) => i.magnitude)).toEqual([6.4, 4.8, 3.1]);
  });

  it("should deduplicate by entityKey keeping the latest record", async () => {
    const older = {
      ...makeSeismicRecord("us-a", 3.0),
      timestamp: "2024-01-15T10:00:00Z",
    };
    const newer = {
      ...makeSeismicRecord("us-a", 5.5),
      timestamp: "2024-01-15T11:00:00Z",
    };
    const view = await plugin.process([older, newer], makeContext());
    expect(view?.items).toHaveLength(1);
    expect(view?.items[0]?.magnitude).toBe(5.5);
  });

  it("should return null when no seismic records are present", async () => {
    const unrelated: PulseRecord = {
      type: "crypto.price",
      timestamp: "2024-01-15T11:00:00Z",
      source: "other",
      data: {},
    };
    const view = await plugin.process([unrelated], makeContext());
    expect(view).toBeNull();
  });

  it("should return null when records array is empty", async () => {
    const view = await plugin.process([], makeContext());
    expect(view).toBeNull();
  });
});
