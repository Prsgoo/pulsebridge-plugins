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

export const TELEGRAM_INTEGRATION_ID = "@prsgoo/integration-telegram";

const TELEGRAM_API_BASE = "https://api.telegram.org";

export const telegramConfigSchema = z.object({
  chatId: z.string().min(1),
});

export type TelegramConfig = z.infer<typeof telegramConfigSchema>;

const sendPayloadSchema = z.object({
  title: z.string().min(1),
  message: z.string().min(1),
  priority: z.enum(["high", "normal", "low"]).optional(),
  tags: z.array(z.string()).optional(),
});

const SEND_ACTION: ActionDefinition = {
  id: "send",
  name: "Send Message",
  description: "Send a message to the configured Telegram chat.",
};

export class TelegramIntegrationPlugin implements ActionIntegrationPlugin<TelegramConfig> {
  readonly manifest: IntegrationPluginManifest = {
    id: TELEGRAM_INTEGRATION_ID,
    name: "Telegram Integration",
    version: "0.1.0",
    kind: PluginKinds.INTEGRATION,
    operations: [],
    actions: [SEND_ACTION],
    auth: {
      type: "apiKey",
      secrets: [
        {
          key: "TELEGRAM_BOT_TOKEN",
          description: "Telegram Bot API token from @BotFather.",
          required: true,
        },
      ],
    },
  };

  readonly configSchema = telegramConfigSchema;

  private config: TelegramConfig = { chatId: "" };

  configure(config: TelegramConfig): void {
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

    const token = context.secrets.get("TELEGRAM_BOT_TOKEN");
    if (!token) {
      throw new Error("TELEGRAM_BOT_TOKEN secret is required.");
    }

    const { title, message } = parsed.data;
    const text = `<b>${title}</b>\n${message}`;
    const url = `${TELEGRAM_API_BASE}/bot${token}/sendMessage`;

    context.logger.debug("Sending Telegram message.", {
      chatId: this.config.chatId,
      title,
    });

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: this.config.chatId,
        text,
        parse_mode: "HTML",
      }),
      signal: context.signal ?? null,
    });

    if (response.status === 429) {
      throw new RateLimitError("Telegram API rate limit exceeded.");
    }

    if (!response.ok) {
      throw new TransientError(
        `Telegram API returned HTTP ${response.status} for chat '${this.config.chatId}'.`,
      );
    }

    return { data: { ok: true } };
  }
}
