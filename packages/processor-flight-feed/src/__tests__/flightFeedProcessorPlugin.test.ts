import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PulseRecord, RuntimeContext } from "pulsebridge";
import {
  FlightFeedProcessorPlugin,
  FLIGHT_FEED_PROCESSOR_ID,
  VIEW_FLIGHT_FEED,
} from "../flightFeedProcessorPlugin.js";

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function makeContext(): RuntimeContext {
  return {
    logger: mockLogger,
    now: () => new Date("2024-06-01T12:00:00Z"),
    secrets: { get: () => undefined, has: () => false },
  } as unknown as RuntimeContext;
}

function makeFlightRecord(
  icao24: string,
  opts: {
    timestamp?: string;
    callsign?: string | null;
    latitude?: number;
    longitude?: number;
    altitudeM?: number | null;
    speedKt?: number | null;
    heading?: number | null;
    onGround?: boolean;
    source?: string;
  } = {},
): PulseRecord {
  return {
    type: "flight.position",
    timestamp: opts.timestamp ?? "2024-06-01T11:00:00Z",
    source: opts.source ?? "@prsgoo/integration-opensky",
    entityKey: `icao24:${icao24}`,
    data: {
      icao24,
      callsign: opts.callsign !== undefined ? opts.callsign : "UAL123",
      latitude: opts.latitude ?? 51.5,
      longitude: opts.longitude ?? -0.1,
      altitudeM: opts.altitudeM !== undefined ? opts.altitudeM : 10000,
      speedKt: opts.speedKt !== undefined ? opts.speedKt : 450,
      heading: opts.heading !== undefined ? opts.heading : 90,
      onGround: opts.onGround ?? false,
      lastContact: opts.timestamp ?? "2024-06-01T11:00:00Z",
    },
  };
}

describe("FlightFeedProcessorPlugin", () => {
  let plugin: FlightFeedProcessorPlugin;

  beforeEach(() => {
    plugin = new FlightFeedProcessorPlugin();
    vi.clearAllMocks();
  });

  it("should produce a flight-feed view from flight.position records", async () => {
    const view = await plugin.process(
      [makeFlightRecord("abc123")],
      makeContext(),
    );
    expect(view).not.toBeNull();
    expect(view?.view).toBe(VIEW_FLIGHT_FEED);
    expect(view?.items).toHaveLength(1);
  });

  it("should return null when records array is empty", async () => {
    const view = await plugin.process([], makeContext());
    expect(view).toBeNull();
  });

  it("should return null when records contain no flight.position type", async () => {
    const unrelated: PulseRecord = {
      type: "seismic.event",
      timestamp: "2024-06-01T11:00:00Z",
      source: "other",
      data: {},
    };
    const view = await plugin.process([unrelated], makeContext());
    expect(view).toBeNull();
  });

  it("should deduplicate by entityKey keeping the latest record", async () => {
    const older = makeFlightRecord("abc123", {
      timestamp: "2024-06-01T10:00:00Z",
      callsign: "OLD001",
    });
    const newer = makeFlightRecord("abc123", {
      timestamp: "2024-06-01T11:00:00Z",
      callsign: "NEW001",
    });
    const view = await plugin.process([older, newer], makeContext());
    expect(view?.items).toHaveLength(1);
    expect(view?.items[0]?.callsign).toBe("NEW001");
  });

  it("should keep newest when older record arrives after newer in same batch", async () => {
    const newer = makeFlightRecord("abc123", {
      timestamp: "2024-06-01T11:00:00Z",
      callsign: "NEW001",
    });
    const older = makeFlightRecord("abc123", {
      timestamp: "2024-06-01T10:00:00Z",
      callsign: "OLD001",
    });
    const view = await plugin.process([newer, older], makeContext());
    expect(view?.items).toHaveLength(1);
    expect(view?.items[0]?.callsign).toBe("NEW001");
  });

  it("should filter out non-flight.position records and process only matching ones", async () => {
    const flightRecord = makeFlightRecord("abc123");
    const unrelated: PulseRecord = {
      type: "crypto.price",
      timestamp: "2024-06-01T11:00:00Z",
      source: "other",
      data: {},
    };
    const view = await plugin.process([flightRecord, unrelated], makeContext());
    expect(view?.items).toHaveLength(1);
    expect(view?.items[0]?.icao24).toBe("abc123");
  });

  it("should sort items by updatedAt descending", async () => {
    const records = [
      makeFlightRecord("aaa111", { timestamp: "2024-06-01T10:00:00Z" }),
      makeFlightRecord("bbb222", { timestamp: "2024-06-01T12:00:00Z" }),
      makeFlightRecord("ccc333", { timestamp: "2024-06-01T11:00:00Z" }),
    ];
    const view = await plugin.process(records, makeContext());
    expect(view?.items.map((i) => i.icao24)).toEqual([
      "bbb222",
      "ccc333",
      "aaa111",
    ]);
  });

  it("should map all FlightFeedItem fields correctly", async () => {
    const record = makeFlightRecord("abc123", {
      callsign: "BA456",
      latitude: 48.85,
      longitude: 2.35,
      altitudeM: 11000,
      speedKt: 480,
      heading: 270,
      onGround: false,
      source: "@prsgoo/integration-adsbfi",
      timestamp: "2024-06-01T11:30:00Z",
    });
    const view = await plugin.process([record], makeContext());
    const item = view?.items[0];
    expect(item?.id).toBe("icao24:abc123");
    expect(item?.icao24).toBe("abc123");
    expect(item?.callsign).toBe("BA456");
    expect(item?.latitude).toBe(48.85);
    expect(item?.longitude).toBe(2.35);
    expect(item?.altitudeM).toBe(11000);
    expect(item?.speedKt).toBe(480);
    expect(item?.heading).toBe(270);
    expect(item?.onGround).toBe(false);
    expect(item?.source).toBe("@prsgoo/integration-adsbfi");
    expect(item?.updatedAt).toBe("2024-06-01T11:30:00Z");
  });

  it("should set view field to flight-feed", async () => {
    const view = await plugin.process(
      [makeFlightRecord("abc123")],
      makeContext(),
    );
    expect(view?.view).toBe("flight-feed");
  });

  it("should set generatedAt to context.now() ISO string", async () => {
    const view = await plugin.process(
      [makeFlightRecord("abc123")],
      makeContext(),
    );
    expect(view?.generatedAt).toBe("2024-06-01T12:00:00.000Z");
  });

  it("should expose the correct manifest id", () => {
    expect(plugin.manifest.id).toBe(FLIGHT_FEED_PROCESSOR_ID);
  });

  it("should expose processor kind in manifest", () => {
    expect(plugin.manifest.kind).toBe("processor");
  });

  it("should declare flight.position in manifest consumes", () => {
    expect(plugin.manifest.consumes).toContain("flight.position");
  });

  it("should declare flight-feed in manifest produces", () => {
    expect(plugin.manifest.produces).toContain("flight-feed");
  });

  it("should log debug message when no flight records are present", async () => {
    await plugin.process([], makeContext());
    expect(mockLogger.debug).toHaveBeenCalledWith(
      "No flight records to process.",
      { pluginId: FLIGHT_FEED_PROCESSOR_ID },
    );
  });

  it("should handle null callsign", async () => {
    const record = makeFlightRecord("abc123", { callsign: null });
    const view = await plugin.process([record], makeContext());
    expect(view?.items[0]?.callsign).toBeNull();
  });

  it("should handle null altitudeM", async () => {
    const record = makeFlightRecord("abc123", { altitudeM: null });
    const view = await plugin.process([record], makeContext());
    expect(view?.items[0]?.altitudeM).toBeNull();
  });

  it("should handle onGround true", async () => {
    const record = makeFlightRecord("abc123", { onGround: true });
    const view = await plugin.process([record], makeContext());
    expect(view?.items[0]?.onGround).toBe(true);
  });
});
