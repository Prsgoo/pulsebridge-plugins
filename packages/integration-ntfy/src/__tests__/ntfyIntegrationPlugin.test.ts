import { describe, it, expect, vi, beforeEach } from "vitest";
import { PluginKinds, TransientError } from "pulsebridge";
import {
  NtfyIntegrationPlugin,
  NTFY_INTEGRATION_ID,
  ntfyConfigSchema,
} from "../ntfyIntegrationPlugin.js";

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

function makeOkResponse() {
  return {
    ok: true,
    status: 200,
  } as unknown as Response;
}

function makeErrorResponse(status: number) {
  return {
    ok: false,
    status,
  } as unknown as Response;
}

describe("NtfyIntegrationPlugin manifest", () => {
  it("should have the correct plugin id", () => {
    const plugin = new NtfyIntegrationPlugin();
    expect(plugin.manifest.id).toBe(NTFY_INTEGRATION_ID);
  });

  it("should be of INTEGRATION kind", () => {
    const plugin = new NtfyIntegrationPlugin();
    expect(plugin.manifest.kind).toBe(PluginKinds.INTEGRATION);
  });

  it("should declare a send action", () => {
    const plugin = new NtfyIntegrationPlugin();
    expect(plugin.manifest.actions).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "send" })]),
    );
  });

  it("should declare no poll operations", () => {
    const plugin = new NtfyIntegrationPlugin();
    expect(plugin.manifest.operations).toHaveLength(0);
  });

  it("should declare NTFY_TOKEN as an optional secret", () => {
    const plugin = new NtfyIntegrationPlugin();
    const secret = plugin.manifest.auth?.secrets.find(
      (s) => s.key === "NTFY_TOKEN",
    );
    expect(secret?.required).toBe(false);
  });
});

describe("ntfyConfigSchema", () => {
  it("should default serverUrl to https://ntfy.sh", () => {
    const result = ntfyConfigSchema.parse({ topic: "alerts" });
    expect(result.serverUrl).toBe("https://ntfy.sh");
  });

  it("should accept a custom serverUrl", () => {
    const result = ntfyConfigSchema.parse({
      serverUrl: "https://my.ntfy.instance",
      topic: "alerts",
    });
    expect(result.serverUrl).toBe("https://my.ntfy.instance");
  });

  it("should reject an empty topic", () => {
    expect(() => ntfyConfigSchema.parse({ topic: "" })).toThrow();
  });
});

describe("NtfyIntegrationPlugin invoke send", () => {
  let plugin: NtfyIntegrationPlugin;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    plugin = new NtfyIntegrationPlugin();
    plugin.configure({ serverUrl: "https://ntfy.sh", topic: "test-alerts" });
    fetchMock = vi.fn().mockResolvedValue(makeOkResponse());
    vi.stubGlobal("fetch", fetchMock);
  });

  it("should POST to the configured topic URL", async () => {
    await plugin.invoke("send", makeContext(), {
      title: "Test",
      message: "Hello",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://ntfy.sh/test-alerts",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("should set the Title header from the payload", async () => {
    await plugin.invoke("send", makeContext(), {
      title: "Alert Title",
      message: "body",
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Title"]).toBe(
      "Alert Title",
    );
  });

  it("should set Priority header 5 for high priority", async () => {
    await plugin.invoke("send", makeContext(), {
      title: "t",
      message: "m",
      priority: "high",
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Priority"]).toBe("5");
  });

  it("should set Priority header 3 for normal priority", async () => {
    await plugin.invoke("send", makeContext(), {
      title: "t",
      message: "m",
      priority: "normal",
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Priority"]).toBe("3");
  });

  it("should set Priority header 2 for low priority", async () => {
    await plugin.invoke("send", makeContext(), {
      title: "t",
      message: "m",
      priority: "low",
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Priority"]).toBe("2");
  });

  it("should omit Priority header when priority is not specified", async () => {
    await plugin.invoke("send", makeContext(), { title: "t", message: "m" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(
      (init.headers as Record<string, string>)["Priority"],
    ).toBeUndefined();
  });

  it("should set Tags header as comma-separated list", async () => {
    await plugin.invoke("send", makeContext(), {
      title: "t",
      message: "m",
      tags: ["warning", "quake"],
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Tags"]).toBe(
      "warning,quake",
    );
  });

  it("should omit Tags header when tags array is empty", async () => {
    await plugin.invoke("send", makeContext(), {
      title: "t",
      message: "m",
      tags: [],
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Tags"]).toBeUndefined();
  });

  it("should set Authorization header when NTFY_TOKEN secret is present", async () => {
    await plugin.invoke("send", makeContext({ NTFY_TOKEN: "mytoken" }), {
      title: "t",
      message: "m",
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer mytoken",
    );
  });

  it("should omit Authorization header when NTFY_TOKEN is not set", async () => {
    await plugin.invoke("send", makeContext(), { title: "t", message: "m" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(
      (init.headers as Record<string, string>)["Authorization"],
    ).toBeUndefined();
  });

  it("should use the message as the request body", async () => {
    await plugin.invoke("send", makeContext(), {
      title: "t",
      message: "earthquake detected",
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBe("earthquake detected");
  });

  it("should return ok: true on success", async () => {
    const result = await plugin.invoke("send", makeContext(), {
      title: "t",
      message: "m",
    });
    expect(result.data).toEqual({ ok: true });
  });

  it("should throw TransientError on non-200 response", async () => {
    fetchMock.mockResolvedValue(makeErrorResponse(500));
    await expect(
      plugin.invoke("send", makeContext(), { title: "t", message: "m" }),
    ).rejects.toBeInstanceOf(TransientError);
  });

  it("should throw on unknown action id", async () => {
    await expect(plugin.invoke("unknown", makeContext(), {})).rejects.toThrow(
      "unknown",
    );
  });

  it("should throw on invalid payload", async () => {
    await expect(
      plugin.invoke("send", makeContext(), { title: "", message: "m" }),
    ).rejects.toThrow();
  });

  it("should URL-encode the topic name", async () => {
    plugin.configure({ serverUrl: "https://ntfy.sh", topic: "my alerts" });
    await plugin.invoke("send", makeContext(), { title: "t", message: "m" });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://ntfy.sh/my%20alerts");
  });
});
