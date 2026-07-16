import {
  PluginKinds,
  RateLimitError,
  TransientError,
  type ActionDefinition,
  type ActionIntegrationPlugin,
  type ActionResult,
  type IntegrationPluginManifest,
  type RuntimeContext,
} from "pulsebridge";
import { z } from "zod";

export const DISCORD_INTEGRATION_ID = "@prsgoo/integration-discord";

const DISCORD_COLOR: Record<string, number> = {
  high: 0xed4245,
  normal: 0x5865f2,
  low: 0xb9bbbe,
};

export const discordConfigSchema = z.object({});

export type DiscordConfig = z.infer<typeof discordConfigSchema>;

const sendPayloadSchema = z.object({
  title: z.string().min(1),
  message: z.string().min(1),
  priority: z.enum(["high", "normal", "low"]).optional(),
  tags: z.array(z.string()).optional(),
});

const SEND_ACTION: ActionDefinition = {
  id: "send",
  name: "Send Message",
  description: "Post a message to the configured Discord channel via webhook.",
};

export class DiscordIntegrationPlugin implements ActionIntegrationPlugin<DiscordConfig> {
  readonly manifest: IntegrationPluginManifest = {
    id: DISCORD_INTEGRATION_ID,
    name: "Discord Integration",
    version: "0.1.0",
    kind: PluginKinds.INTEGRATION,
    operations: [],
    actions: [SEND_ACTION],
    auth: {
      type: "apiKey",
      secrets: [
        {
          key: "DISCORD_WEBHOOK_URL",
          description: "Full Discord webhook URL from channel settings.",
          required: true,
        },
      ],
    },
  };

  readonly configSchema = discordConfigSchema;

  private config: DiscordConfig = {};

  configure(config: DiscordConfig): void {
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

    const webhookUrl = context.secrets.get("DISCORD_WEBHOOK_URL");
    if (!webhookUrl) {
      throw new Error("DISCORD_WEBHOOK_URL secret is required.");
    }

    const { title, message, priority } = parsed.data;
    const color = DISCORD_COLOR[priority ?? "normal"];

    context.logger.debug("Sending Discord message.", { title, priority });

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [{ title, description: message, color }],
      }),
      signal: context.signal ?? null,
    });

    if (response.status === 429) {
      throw new RateLimitError("Discord API rate limit exceeded.");
    }

    if (!response.ok) {
      throw new TransientError(
        `Discord webhook returned HTTP ${response.status}.`,
      );
    }

    return { data: { ok: true } };
  }
}
