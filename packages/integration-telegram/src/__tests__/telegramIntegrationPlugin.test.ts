import { describe, it, expect, vi, beforeEach } from "vitest";
import { PluginKinds, RateLimitError, TransientError } from "pulsebridge";
import {
  TelegramIntegrationPlugin,
  TELEGRAM_INTEGRATION_ID,
  telegramConfigSchema,
} from "../telegramIntegrationPlugin.js";

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

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

const STUB = "stub";
const CTX = makeContext({ TELEGRAM_BOT_TOKEN: STUB });

function makeOkResponse() {
  return { ok: true, status: 200 } as unknown as Response;
}

function makeErrorResponse(status: number) {
  return { ok: false, status } as unknown as Response;
}

describe("TelegramIntegrationPlugin manifest", () => {
  it("should have the correct plugin id", () => {
    const plugin = new TelegramIntegrationPlugin();
    expect(plugin.manifest.id).toBe(TELEGRAM_INTEGRATION_ID);
  });

  it("should be of INTEGRATION kind", () => {
    const plugin = new TelegramIntegrationPlugin();
    expect(plugin.manifest.kind).toBe(PluginKinds.INTEGRATION);
  });

  it("should declare a send action", () => {
    const plugin = new TelegramIntegrationPlugin();
    expect(plugin.manifest.actions).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "send" })]),
    );
  });

  it("should declare no poll operations", () => {
    const plugin = new TelegramIntegrationPlugin();
    expect(plugin.manifest.operations).toHaveLength(0);
  });

  it("should declare TELEGRAM_BOT_TOKEN as a required secret", () => {
    const plugin = new TelegramIntegrationPlugin();
    const secret = plugin.manifest.auth?.secrets.find(
      (s) => s.key === "TELEGRAM_BOT_TOKEN",
    );
    expect(secret?.required).toBe(true);
  });
});

describe("telegramConfigSchema", () => {
  it("should accept a valid chatId", () => {
    const result = telegramConfigSchema.parse({ chatId: "-100123456789" });
    expect(result.chatId).toBe("-100123456789");
  });

  it("should reject an empty chatId", () => {
    expect(() => telegramConfigSchema.parse({ chatId: "" })).toThrow();
  });
});

describe("TelegramIntegrationPlugin invoke send", () => {
  let plugin: TelegramIntegrationPlugin;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    plugin = new TelegramIntegrationPlugin();
    plugin.configure({ chatId: "-100123456789" });
    fetchMock = vi.fn().mockResolvedValue(makeOkResponse());
    vi.stubGlobal("fetch", fetchMock);
  });

  it("should POST to the Telegram sendMessage endpoint with the bot token", async () => {
    await plugin.invoke("send", CTX, { title: "Alert", message: "Earthquake" });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.telegram.org/bot${STUB}/sendMessage`);
  });

  it("should format text as HTML with bold title", async () => {
    await plugin.invoke("send", CTX, {
      title: "Alert",
      message: "Earthquake detected",
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.text).toBe("<b>Alert</b>\nEarthquake detected");
  });

  it("should set parse_mode to HTML", async () => {
    await plugin.invoke("send", CTX, { title: "t", message: "m" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.parse_mode).toBe("HTML");
  });

  it("should send to the configured chat_id", async () => {
    await plugin.invoke("send", CTX, { title: "t", message: "m" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.chat_id).toBe("-100123456789");
  });

  it("should set Content-Type to application/json", async () => {
    await plugin.invoke("send", CTX, { title: "t", message: "m" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
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

  it("should throw when TELEGRAM_BOT_TOKEN secret is missing", async () => {
    await expect(
      plugin.invoke("send", makeContext(), { title: "t", message: "m" }),
    ).rejects.toThrow("TELEGRAM_BOT_TOKEN");
  });
});
