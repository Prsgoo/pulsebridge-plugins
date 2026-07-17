import { describe, it, expect, vi, beforeEach } from "vitest";
import { PluginKinds, RateLimitError, TransientError } from "pulsebridge";
import {
  DiscordIntegrationPlugin,
  DISCORD_INTEGRATION_ID,
  discordConfigSchema,
} from "../discordIntegrationPlugin.js";

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const STUB_URL = "https://discord.test/stub";

function makeContext(secrets: Record<string, string> = {}) {
  return {
    logger: mockLogger,
    now: () => new Date("2024-01-15T12:00:00Z"),
    secrets: {
      get: (k: string) => secrets[k],
      has: (k: string) => k in secrets,
    },
    signal: undefined,
  };
}

const CTX = makeContext({ DISCORD_WEBHOOK_URL: STUB_URL });

function makeOkResponse() {
  return { ok: true, status: 200 } as unknown as Response;
}

function makeErrorResponse(status: number) {
  return { ok: false, status } as unknown as Response;
}

describe("DiscordIntegrationPlugin manifest", () => {
  it("should have the correct plugin id", () => {
    const plugin = new DiscordIntegrationPlugin();
    expect(plugin.manifest.id).toBe(DISCORD_INTEGRATION_ID);
  });

  it("should be of INTEGRATION kind", () => {
    const plugin = new DiscordIntegrationPlugin();
    expect(plugin.manifest.kind).toBe(PluginKinds.INTEGRATION);
  });

  it("should declare a send action", () => {
    const plugin = new DiscordIntegrationPlugin();
    expect(plugin.manifest.actions).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "send" })]),
    );
  });

  it("should declare no poll operations", () => {
    const plugin = new DiscordIntegrationPlugin();
    expect(plugin.manifest.operations).toHaveLength(0);
  });

  it("should declare DISCORD_WEBHOOK_URL as a required secret", () => {
    const plugin = new DiscordIntegrationPlugin();
    const secret = plugin.manifest.auth?.secrets.find(
      (s) => s.key === "DISCORD_WEBHOOK_URL",
    );
    expect(secret?.required).toBe(true);
  });
});

describe("discordConfigSchema", () => {
  it("should accept an empty config object", () => {
    expect(() => discordConfigSchema.parse({})).not.toThrow();
  });
});

describe("DiscordIntegrationPlugin invoke send", () => {
  let plugin: DiscordIntegrationPlugin;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    plugin = new DiscordIntegrationPlugin();
    plugin.configure({});
    fetchMock = vi.fn().mockResolvedValue(makeOkResponse());
    vi.stubGlobal("fetch", fetchMock);
  });

  it("should POST to the webhook URL from secrets", async () => {
    await plugin.invoke("send", CTX, { title: "t", message: "m" });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(STUB_URL);
  });

  it("should set Content-Type to application/json", async () => {
    await plugin.invoke("send", CTX, { title: "t", message: "m" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
  });

  it("should send an embed with title and description", async () => {
    await plugin.invoke("send", CTX, {
      title: "Alert",
      message: "Earthquake detected",
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.embeds[0].title).toBe("Alert");
    expect(body.embeds[0].description).toBe("Earthquake detected");
  });

  it("should use red color for high priority", async () => {
    await plugin.invoke("send", CTX, {
      title: "t",
      message: "m",
      priority: "high",
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.embeds[0].color).toBe(0xed4245);
  });

  it("should use blue color for normal priority", async () => {
    await plugin.invoke("send", CTX, {
      title: "t",
      message: "m",
      priority: "normal",
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.embeds[0].color).toBe(0x5865f2);
  });

  it("should use gray color for low priority", async () => {
    await plugin.invoke("send", CTX, {
      title: "t",
      message: "m",
      priority: "low",
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.embeds[0].color).toBe(0xb9bbbe);
  });

  it("should use blue color when priority is not specified", async () => {
    await plugin.invoke("send", CTX, { title: "t", message: "m" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.embeds[0].color).toBe(0x5865f2);
  });

  it("should return ok: true on success", async () => {
    const result = await plugin.invoke("send", CTX, {
      title: "t",
      message: "m",
    });
    expect(result.data).toEqual({ ok: true });
  });

  it("should throw RateLimitError on 429", async () => {
    fetchMock.mockResolvedValue(makeErrorResponse(429));
    await expect(
      plugin.invoke("send", CTX, { title: "t", message: "m" }),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it("should throw TransientError on non-200 non-429 response", async () => {
    fetchMock.mockResolvedValue(makeErrorResponse(500));
    await expect(
      plugin.invoke("send", CTX, { title: "t", message: "m" }),
    ).rejects.toBeInstanceOf(TransientError);
  });

  it("should throw on unknown action id", async () => {
    await expect(plugin.invoke("unknown", CTX, {})).rejects.toThrow("unknown");
  });

  it("should throw on invalid payload", async () => {
    await expect(
      plugin.invoke("send", CTX, { title: "", message: "m" }),
    ).rejects.toThrow();
  });

  it("should throw when DISCORD_WEBHOOK_URL secret is missing", async () => {
    await expect(
      plugin.invoke("send", makeContext(), { title: "t", message: "m" }),
    ).rejects.toThrow("DISCORD_WEBHOOK_URL");
  });
});
