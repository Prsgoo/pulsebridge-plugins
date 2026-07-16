import {
  PluginKinds,
  TransientError,
  type ActionDefinition,
  type ActionIntegrationPlugin,
  type ActionResult,
  type IntegrationPluginManifest,
  type RuntimeContext,
} from "pulsebridge";
import { z } from "zod";

export const NTFY_INTEGRATION_ID = "@prsgoo/integration-ntfy";

const DEFAULT_SERVER_URL = "https://ntfy.sh";

const NTFY_PRIORITY: Record<string, number> = {
  high: 5,
  normal: 3,
  low: 2,
};

export const ntfyConfigSchema = z.object({
  serverUrl: z.string().url().default(DEFAULT_SERVER_URL),
  topic: z.string().min(1),
});

export type NtfyConfig = z.infer<typeof ntfyConfigSchema>;

const sendPayloadSchema = z.object({
  title: z.string().min(1),
  message: z.string().min(1),
  priority: z.enum(["high", "normal", "low"]).optional(),
  tags: z.array(z.string()).optional(),
});

const SEND_ACTION: ActionDefinition = {
  id: "send",
  name: "Send Notification",
  description: "POST a notification to the configured ntfy topic.",
};

export class NtfyIntegrationPlugin implements ActionIntegrationPlugin<NtfyConfig> {
  readonly manifest: IntegrationPluginManifest = {
    id: NTFY_INTEGRATION_ID,
    name: "ntfy Integration",
    version: "0.1.0",
    kind: PluginKinds.INTEGRATION,
    operations: [],
    actions: [SEND_ACTION],
    auth: {
      type: "apiKey",
      secrets: [
        {
          key: "NTFY_TOKEN",
          description: "Bearer token for authenticated ntfy topics (optional).",
          required: false,
        },
      ],
    },
  };

  readonly configSchema = ntfyConfigSchema;

  private config: NtfyConfig = { serverUrl: DEFAULT_SERVER_URL, topic: "" };

  configure(config: NtfyConfig): void {
    this.config = config;
  }

  async invoke(
    actionId: string,
    context: RuntimeContext,
    payload?: unknown,
  ): Promise<ActionResult> {
    if (actionId !== "send") {
      throw new Error(
        `Action '${actionId}' is not supported by '${this.manifest.id}'.`,
      );
    }

    const parsed = sendPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join(", ");
      throw new Error(`Invalid send payload: ${issues}`);
    }

    const { title, message, priority, tags } = parsed.data;
    const url = `${this.config.serverUrl}/${encodeURIComponent(this.config.topic)}`;

    const headers: Record<string, string> = {
      "Content-Type": "text/plain",
      Title: title,
    };

    if (priority !== undefined) {
      headers["Priority"] = String(NTFY_PRIORITY[priority]);
    }

    if (tags !== undefined && tags.length > 0) {
      headers["Tags"] = tags.join(",");
    }

    const token = context.secrets.get("NTFY_TOKEN");
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    context.logger.debug("Sending ntfy notification.", {
      url,
      title,
      priority,
    });

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: message,
      signal: context.signal ?? null,
    });

    if (!response.ok) {
      throw new TransientError(
        `ntfy returned HTTP ${response.status} for topic '${this.config.topic}'.`,
      );
    }

    return { data: { ok: true } };
  }
}
