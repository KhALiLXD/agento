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
import {
  chunkMessage,
  detectLanguage,
  messagesFor,
  renderResultText,
  type DiscordLanguage,
} from "./renderers.mjs";

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
const languages = new Map<string, DiscordLanguage>();
const controls = new Map<string, { token: string; messages: Message[] }>();
async function retireControls(sessionId: string, token?: string) {
  const old = controls.get(sessionId);
  if (!old || old.token === token) return;
  controls.delete(sessionId);
  await Promise.all(
    old.messages.map((message) =>
      message.edit({ components: [] }).catch(() => undefined),
    ),
  );
}
function rememberControls(result: AgentResult, messages: Message[]) {
  const token = result.selection?.id ?? result.confirmation?.id;
  if (!token) return;
  const old = controls.get(result.sessionId);
  controls.set(result.sessionId, {
    token,
    messages: [
      ...(old?.token === token ? old.messages : []),
      messages[messages.length - 1],
    ].slice(-20),
  });
  if (controls.size > 1000) void retireControls(controls.keys().next().value!);
}
const base = (channelId: string, userId: string) => ({
  sessionId: `discord_${channelId}_${userId}`,
  ...(userToken && userId === testUserId ? { auth: { token: userToken } } : {}),
  context: { discord: { user_id: userId, channel_id: channelId } },
});
function view(result: AgentResult, language: DiscordLanguage, page = 0) {
  const components: Array<
    ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>
  > = [];
  if (result.status === "needs_confirmation" && result.confirmation) {
    const id = result.confirmation.id;
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`agento:confirm:${id}`)
          .setLabel(language === "ar" ? "تأكيد" : "Confirm")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`agento:cancel:${id}`)
          .setLabel(language === "ar" ? "إلغاء" : "Cancel")
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
            `${language === "ar" ? "اختاري" : "Choose"} (${first + 1}-${first + displayed.length} / ${options.length})`,
          )
          .addOptions(
            displayed.map((o, i) => ({
              label: `${first + i + 1}. ${o.label}`.slice(0, 100),
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
            .setLabel(language === "ar" ? "السابق" : "Previous")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page === 0),
          new ButtonBuilder()
            .setCustomId(`agento:page:${id}:${page + 1}`)
            .setLabel(language === "ar" ? "التالي" : "Next")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(first + 25 >= options.length),
        ),
      );
  }
  return {
    content: renderResultText(result, language),
    components,
    allowedMentions: { parse: [] as [], repliedUser: false },
  };
}
async function replyResult(
  message: Message,
  result: AgentResult,
  language: DiscordLanguage,
) {
  const rendered = view(result, language);
  const chunks = chunkMessage(rendered.content, 1900);
  const responses: Message[] = [];
  let previous: Message | undefined;
  for (const [index, content] of chunks.entries()) {
    const payload = {
      content,
      components: index === chunks.length - 1 ? rendered.components : [],
      allowedMentions: rendered.allowedMentions,
    };
    previous = previous
      ? await previous.reply(payload)
      : await message.reply(payload);
    responses.push(previous);
  }
  return responses;
}
async function editInteractionResult(
  interaction: Extract<Interaction, { customId: string }>,
  result: AgentResult,
  language: DiscordLanguage,
) {
  const rendered = view(result, language);
  const chunks = chunkMessage(rendered.content, 1900);
  const messages: Message[] = [];
  const first = await interaction.editReply({
    content: chunks[0],
    components: chunks.length === 1 ? rendered.components : [],
    allowedMentions: rendered.allowedMentions,
  });
  messages.push(first);
  for (let index = 1; index < chunks.length; index++)
    messages.push(
      await interaction.followUp({
        content: chunks[index],
        components: index === chunks.length - 1 ? rendered.components : [],
        allowedMentions: rendered.allowedMentions,
        fetchReply: true,
      }),
    );
  return messages;
}
async function onMessage(message: Message) {
  if (message.author.bot || !message.content.trim()) return;
  const reference = message.reference?.messageId
    ? await message.fetchReference().catch(() => undefined)
    : undefined;
  const input = message.content.replace(/<@!?\d+>/g, "").trim();
  const command = input.toLocaleLowerCase().replace(/^\//, "-");
  const isCommand = ["-tools", "-reset", "-cancel"].includes(command);
  if (
    !message.mentions.has(client.user!.id) &&
    reference?.author.id !== client.user!.id &&
    !isCommand
  )
    return;
  if (processed.has(message.id)) return;
  processed.add(message.id);
  setTimeout(() => processed.delete(message.id), 60_000).unref();
  if (!input) {
    await message.reply("اطلب خدمة، أو اكتب -tools لعرض الأدوات.");
    return;
  }
  const request = base(message.channelId, message.author.id);
  const language = detectLanguage(
    isCommand ? "" : input,
    languages.get(request.sessionId) ?? "en",
  );
  languages.set(request.sessionId, language);
  while (languages.size > 1000)
    languages.delete(languages.keys().next().value!);
  if (reference && !isCommand) {
    const reply = prompts.resolveReply(
      reference.id,
      message.author.id,
      request.sessionId,
    );
    console.log("Reply state:", reply);
    if (reply.state === "forbidden" || reply.state === "stale") {
      await message.reply(
        reply.state === "forbidden"
          ? "هذا الاختيار مرتبط بصاحب الطلب."
          : "هذه القائمة لم تعد فعالة. استخدمي أحدث رسالة من روزي.",
      );
      return;
    }
  }
  if ("sendTyping" in message.channel) await message.channel.sendTyping();
  if (command === "-tools") {
    await message.reply(
      runtime
        .listTools()
        .map((t) => t.name)
        .join("\n"),
    );
    return;
  }
  if (command === "-reset") {
    await runtime.clearSession(request.sessionId);
    await retireControls(request.sessionId);
    prompts.clear(request.sessionId);
    languages.delete(request.sessionId);
    await message.reply("تم مسح الجلسة.");
    return;
  }
  const result =
    command === "-cancel"
      ? await runtime.cancel(request)
      : await runtime.chat({ ...request, message: input });
  prompts.update(result, language);
  await retireControls(
    request.sessionId,
    result.selection?.id ?? result.confirmation?.id,
  );
  const responses = await replyResult(message, result, language);
  rememberControls(result, responses);
  for (const response of responses)
    prompts.remember(response.id, message.author.id, result, language);
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
    false,
  );
  if (!prompt) {
    await interaction.reply({
      content: "هذا الطلب منتهي أو مرتبط بمستخدم آخر. ابدأ طلبًا جديدًا.",
      flags: 64,
    });
    return;
  }
  const language = prompt.language;
  if (action === "page") {
    const page = Number(pageText);
    if (
      !Number.isInteger(page) ||
      page < 0 ||
      page * 25 >= (prompt.result.selection?.options.length ?? 0)
    ) {
      await interaction.reply({
        content: messagesFor(language).stale,
        flags: 64,
      });
      return;
    }
    await interaction.update({
      components: view(prompt.result, language, page).components,
    });
    return;
  }
  if (
    action === "select" &&
    (!interaction.isStringSelectMenu() ||
      !/^\d+$/.test(interaction.values[0] ?? "") ||
      !prompt.result.selection?.options[Number(interaction.values[0])])
  ) {
    await interaction.reply({
      content: messagesFor(language).select,
      flags: 64,
    });
    return;
  }
  prompts.resolve(
    interaction.message.id,
    interaction.user.id,
    request.sessionId,
    action,
    id,
    true,
  );
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
  prompts.update(result, language);
  await retireControls(
    request.sessionId,
    result.selection?.id ?? result.confirmation?.id,
  );
  const responses = await editInteractionResult(interaction, result, language);
  rememberControls(result, responses);
  for (const response of responses)
    prompts.remember(response.id, interaction.user.id, result, language);
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
