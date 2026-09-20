import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  StringSelectMenuBuilder,
  type Interaction,
  type Message,
} from "discord.js";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { AgentRuntime, type AgentResult } from "../../dist/index.js";
import { loadExampleConfig } from "../shared/config.mjs";
import { PromptRegistry } from "./prompts.mjs";

dotenv.config({ path: fileURLToPath(new URL("./.env", import.meta.url)) });
const discordToken = process.env.DISCORD_BOT_TOKEN;
if (!discordToken)
  throw new Error("Set DISCORD_BOT_TOKEN in examples/discord-bot/.env.");
const userToken = process.env.AGENTO_USER_ACCESS_TOKEN;
const testUserId = process.env.DISCORD_TEST_USER_ID;
if (userToken && !testUserId)
  throw new Error(
    "Set DISCORD_TEST_USER_ID to bind the test API token to your own Discord account.",
  );
const configPath =
  process.env.AGENTO_CONFIG_PATH ??
  new URL("./agent-config.yml", import.meta.url);
const config = await loadExampleConfig(configPath);
const runtime = await AgentRuntime.create({
  config,
  presentation: "both",
  onEvent:
    process.env.AGENTO_DEBUG === "true"
      ? (e) => console.log(`[${e.name}]`, JSON.stringify(e.details))
      : undefined,
});
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  allowedMentions: { parse: [], repliedUser: false },
});
const prompts = new PromptRegistry();
const processed = new Set<string>();
const base = (channelId: string, userId: string) => ({
  sessionId: `discord_${channelId}_${userId}`,
  ...(userToken && userId === testUserId ? { auth: { token: userToken } } : {}),
  context: { discord: { user_id: userId, channel_id: channelId } },
});
function text(result: AgentResult): string {
  if (result.status === "error") {
    if (result.error?.code === "AUTH_REJECTED")
      return result.error.details.status === 403
        ? "الـ API رفض العملية: ما عندك صلاحية."
        : "الـ API رفض تسجيل الدخول. حدّث توكن المستخدم وأعد المحاولة.";
    return `${result.error?.code}: ${result.error?.message}`;
  }
  if (result.status === "needs_confirmation")
    return `تأكيد ${result.tool?.id ?? "العملية"}\n${JSON.stringify(result.confirmation?.preview, null, 2)}\nاضغط تأكيد لتنفيذ الطلب.`;
  if (result.status === "needs_selection")
    return [result.message, "اختر من القائمة أو أرسل ID/الاسم الظاهر."]
      .filter(Boolean)
      .join("\n");
  return result.message ?? JSON.stringify(result.data ?? null, null, 2);
}
function view(result: AgentResult, page = 0) {
  const components: Array<
    ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>
  > = [];
  if (result.status === "needs_confirmation" && result.confirmation) {
    const id = result.confirmation.id;
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`agento:confirm:${id}`)
          .setLabel("تأكيد")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`agento:cancel:${id}`)
          .setLabel("إلغاء")
          .setStyle(ButtonStyle.Secondary),
      ),
    );
  }
  if (result.status === "needs_selection" && result.selection) {
    const { id, options } = result.selection;
    const first = page * 25;
    const displayed = options.slice(first, first + 25);
    components.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`agento:select:${id}`)
          .setPlaceholder(
            `اختر (${first + 1}–${first + displayed.length} / ${options.length})`,
          )
          .addOptions(
            displayed.map((o, i) => ({
              label: o.label.slice(0, 100) || o.id.slice(0, 100),
              value: String(first + i),
            })),
          ),
      ),
    );
    if (options.length > 25)
      components.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`agento:page:${id}:${Math.max(0, page - 1)}`)
            .setLabel("السابق")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page === 0),
          new ButtonBuilder()
            .setCustomId(`agento:page:${id}:${page + 1}`)
            .setLabel("التالي")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(first + 25 >= options.length),
        ),
      );
  }
  return {
    content: text(result).slice(0, 1900),
    components,
    allowedMentions: { parse: [] as [], repliedUser: false },
  };
}
async function onMessage(message: Message) {
  if (message.author.bot || !message.content.trim()) return;
  const reference = message.reference?.messageId
    ? await message.fetchReference().catch(() => undefined)
    : undefined;
  if (
    !message.mentions.has(client.user!.id) &&
    reference?.author.id !== client.user!.id
  )
    return;
  if (processed.has(message.id)) return;
  processed.add(message.id);
  setTimeout(() => processed.delete(message.id), 60_000).unref();
  const input = message.content.replace(/<@!?\d+>/g, "").trim();
  if (!input) {
    await message.reply("اطلب خدمة، أو اكتب /tools لعرض الأدوات.");
    return;
  }
  const request = base(message.channelId, message.author.id);
  if (reference) {
    const prompt = prompts.get(reference.id);
    if (
      prompt &&
      (prompt.owner !== message.author.id ||
        prompt.sessionId !== request.sessionId)
    ) {
      await message.reply(
        "ابدأ طلبك بذكر البوت؛ هذا الاختيار مرتبط بصاحب الطلب.",
      );
      return;
    }
  }
  if ("sendTyping" in message.channel) await message.channel.sendTyping();
  if (input === "/tools") {
    await message.reply(
      runtime
        .listTools()
        .map((t) => t.name)
        .join("\n"),
    );
    return;
  }
  if (input === "/reset") {
    await runtime.clearSession(request.sessionId);
    prompts.clear(request.sessionId);
    await message.reply("تم مسح الجلسة.");
    return;
  }
  const result =
    input === "/cancel"
      ? await runtime.cancel(request)
      : await runtime.chat({ ...request, message: input });
  prompts.update(result);
  const response = await message.reply(view(result));
  prompts.remember(response.id, message.author.id, result);
}
async function onInteraction(interaction: Interaction) {
  if (
    (!interaction.isButton() && !interaction.isStringSelectMenu()) ||
    !interaction.customId.startsWith("agento:")
  )
    return;
  const request = base(interaction.channelId!, interaction.user.id);
  const [, action, id, pageText] = interaction.customId.split(":");
  const prompt = prompts.resolve(
    interaction.message.id,
    interaction.user.id,
    request.sessionId,
    action,
    id,
    action !== "page",
  );
  if (!prompt) {
    await interaction.reply({
      content: "هذا الطلب منتهي أو مرتبط بمستخدم آخر. ابدأ طلبًا جديدًا.",
      flags: 64,
    });
    return;
  }
  if (action === "page") {
    const page = Number(pageText);
    if (
      !Number.isInteger(page) ||
      page < 0 ||
      page * 25 >= (prompt.result.selection?.options.length ?? 0)
    )
      return;
    await interaction.update(view(prompt.result, page));
    return;
  }
  await interaction.deferUpdate();
  // Consume the exact displayed prompt. The runtime also rejects expired/replayed IDs.
  let result: AgentResult;
  if (action === "confirm")
    result = await runtime.confirm({ ...request, confirmationId: id });
  else if (action === "cancel") result = await runtime.cancel(request);
  else if (action === "select" && interaction.isStringSelectMenu()) {
    const option =
      prompt.result.selection?.options[Number(interaction.values[0])];
    if (!option) {
      await interaction.editReply({
        content: "الاختيار غير صالح.",
        components: [],
      });
      return;
    }
    result = await runtime.select({
      ...request,
      selectionId: id,
      choice: option.id,
    });
  } else return;
  prompts.update(result);
  await interaction.editReply(view(result));
  prompts.remember(interaction.message.id, interaction.user.id, result);
}
const queues = new Map<string, Promise<unknown>>();
function serialize(key: string, run: () => Promise<void>) {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(run);
  queues.set(key, next);
  void next
    .finally(() => {
      if (queues.get(key) === next) queues.delete(key);
    })
    .catch(() => {});
  return next;
}
client.on(
  Events.MessageCreate,
  (message) =>
    void serialize(`${message.channelId}:${message.author.id}`, () =>
      onMessage(message),
    ).catch(async () => {
      console.error("Discord message operation failed.");
      await message.reply("تعذّر إكمال الطلب.").catch(() => {});
    }),
);
client.on(Events.InteractionCreate, (interaction) => {
  if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;
  const key = `${interaction.channelId}:${interaction.user.id}`;
  if (queues.has(key)) {
    void interaction
      .reply({
        content: "الطلب السابق قيد التنفيذ؛ جرّب بعد انتهائه.",
        flags: 64,
      })
      .catch(() => {});
    return;
  }
  void serialize(key, () => onInteraction(interaction)).catch(() =>
    console.error("Discord interaction failed."),
  );
});
client.once(Events.ClientReady, (ready) =>
  console.log(`AGENTO V2 ready: ${ready.user.tag}`),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    runtime.dispose();
    client.destroy();
  });
try {
  await client.login(discordToken);
} catch {
  runtime.dispose();
  client.destroy();
  console.error("Discord login failed. Check DISCORD_BOT_TOKEN.");
  process.exitCode = 1;
}
