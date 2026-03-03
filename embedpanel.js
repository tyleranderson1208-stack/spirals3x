"use strict";

const fs = require("fs");
const path = require("path");
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionsBitField,
  SlashCommandBuilder,
  PermissionFlagsBits,
} = require("discord.js");

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
function loadJsonSafe(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function saveJson(file, obj) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function parseChannelId(input) {
  const raw = String(input || "").trim();
  const mention = raw.match(/^<#(\d+)>$/);
  if (mention) return mention[1];
  const id = raw.match(/^(\d{8,})$/);
  return id ? id[1] : null;
}

function parseColor(input, fallback) {
  const raw = String(input || "").trim();
  if (!raw) return fallback;
  const norm = raw.replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(norm)) return null;
  return parseInt(norm, 16);
}

function createEmbedPanelSystem(client, commandsDef = [], opts = {}) {
  const BRAND = opts.BRAND || ":blackhole: STELLAR 3X";
  const FOOTER = opts.FOOTER || ":blackhole: STELLAR 3X";
  const COLOR_ACCENT = opts.COLOR_ACCENT ?? 0xb100ff;
  const DATA_DIR = opts.DATA_DIR || path.join(__dirname, "data");

  const PANEL_CHANNEL_ID = opts.EMBED_PANEL_CHANNEL_ID || process.env.EMBED_PANEL_CHANNEL_ID || "";
  const STAFF_ROLE_ID = opts.EMBED_PANEL_STAFF_ROLE_ID || process.env.EMBED_PANEL_STAFF_ROLE_ID || process.env.STAFF_ROLE_ID || "";
  const STATE_FILE = path.join(DATA_DIR, "embedpanel.json");

  const state = loadJsonSafe(STATE_FILE, { panelChannelId: PANEL_CHANNEL_ID, panelMessageId: null });

  const commands = [
    new SlashCommandBuilder()
      .setName("embed-panel")
      .setDescription("Post or refresh the embed creator panel (staff/admin)")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addChannelOption((o) => o.setName("channel").setDescription("Channel to post the embed creator panel").setRequired(false)),
  ];
  if (Array.isArray(commandsDef)) commandsDef.push(...commands);

  function saveState() {
    saveJson(STATE_FILE, state);
  }

  function canUse(interaction) {
    if (interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) return true;
    if (!STAFF_ROLE_ID) return false;
    return interaction.member?.roles?.cache?.has(STAFF_ROLE_ID);
  }

  function panelEmbed() {
    return new EmbedBuilder()
      .setColor(COLOR_ACCENT)
      .setTitle(`${BRAND} — EMBED CREATOR`)
      .setDescription("Create and publish custom embeds on demand.")
      .addFields(
        { name: "How to use", value: "↳ Click **Create Embed**\n↳ Fill in title/body/target channel\n↳ Submit to post instantly", inline: false },
        { name: "Target channel", value: "↳ Enter channel ID or mention format `<#channelId>`", inline: false }
      )
      .setFooter({ text: FOOTER });
  }

  function panelComponents() {
    return [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("embedpanel:create").setLabel("Create Embed").setStyle(ButtonStyle.Primary)
      ),
    ];
  }

  async function getTextChannel(id) {
    if (!id) return null;
    const ch = await client.channels.fetch(id).catch(() => null);
    if (!ch || !("send" in ch)) return null;
    return ch;
  }

  async function postPanelInChannel(channelId) {
    const ch = await getTextChannel(channelId);
    if (!ch || !("messages" in ch)) return null;

    const msg = await ch.send({ embeds: [panelEmbed()], components: panelComponents() }).catch(() => null);
    if (!msg) return null;

    state.panelChannelId = ch.id;
    state.panelMessageId = msg.id;
    saveState();
    return msg;
  }

  async function upsertPanelMessage() {
    const channelId = state.panelChannelId || PANEL_CHANNEL_ID;
    const ch = await getTextChannel(channelId);
    if (!ch || !("messages" in ch)) return;

    if (state.panelMessageId) {
      const existing = await ch.messages.fetch(state.panelMessageId).catch(() => null);
      if (existing) {
        await existing.edit({ embeds: [panelEmbed()], components: panelComponents() }).catch(() => {});
        return;
      }
    }

    const msg = await ch.send({ embeds: [panelEmbed()], components: panelComponents() }).catch(() => null);
    if (!msg) return;
    state.panelChannelId = ch.id;
    state.panelMessageId = msg.id;
    saveState();
  }

  async function handleInteraction(interaction) {
    try {
      if (interaction.isChatInputCommand() && interaction.commandName === "embed-panel") {
        if (!canUse(interaction)) {
          await interaction.reply({ content: "❌ Staff only.", ephemeral: true }).catch(() => {});
          return true;
        }

        const target = interaction.options.getChannel("channel", false);
        const channelId = target?.id || state.panelChannelId || PANEL_CHANNEL_ID || interaction.channelId;
        if (!channelId) {
          await interaction.reply({ content: "❌ No panel channel configured.", ephemeral: true }).catch(() => {});
          return true;
        }

        await interaction.deferReply({ ephemeral: true }).catch(() => {});
        const posted = await postPanelInChannel(channelId);
        if (!posted) {
          await interaction.editReply({ content: "❌ Failed to post embed creator panel in target channel." }).catch(() => {});
          return true;
        }

        await interaction.editReply({ content: `✅ Embed creator panel posted in <#${channelId}>.` }).catch(() => {});
        return true;
      }

      if (interaction.isButton() && interaction.customId === "embedpanel:create") {
        if (!canUse(interaction)) {
          await interaction.reply({ content: "❌ Staff only.", ephemeral: true }).catch(() => {});
          return true;
        }

        const modal = new ModalBuilder().setCustomId("embedpanel:submit").setTitle("Create Embed");
        const title = new TextInputBuilder().setCustomId("title").setLabel("Title").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(256);
        const body = new TextInputBuilder().setCustomId("body").setLabel("Body / Description").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000);
        const channel = new TextInputBuilder().setCustomId("channel").setLabel("Target Channel ID or Mention").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(64);
        const footer = new TextInputBuilder().setCustomId("footer").setLabel("Footer (optional)").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(256);
        const image = new TextInputBuilder().setCustomId("image").setLabel("Image URL or HEX Color (optional)").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(512).setPlaceholder("https://... or #B100FF");

        modal.addComponents(
          new ActionRowBuilder().addComponents(title),
          new ActionRowBuilder().addComponents(body),
          new ActionRowBuilder().addComponents(channel),
          new ActionRowBuilder().addComponents(footer),
          new ActionRowBuilder().addComponents(image)
        );

        await interaction.showModal(modal).catch(() => {});
        return true;
      }

      if (interaction.isModalSubmit() && interaction.customId === "embedpanel:submit") {
        if (!canUse(interaction)) {
          await interaction.reply({ content: "❌ Staff only.", ephemeral: true }).catch(() => {});
          return true;
        }

        const title = interaction.fields.getTextInputValue("title");
        const body = interaction.fields.getTextInputValue("body");
        const channelRaw = interaction.fields.getTextInputValue("channel");
        const footer = interaction.fields.getTextInputValue("footer");
        const imageOrColor = interaction.fields.getTextInputValue("image");

        const channelId = parseChannelId(channelRaw);
        if (!channelId) {
          await interaction.reply({ content: "❌ Invalid channel value. Use channel ID or `<#channelId>`.", ephemeral: true }).catch(() => {});
          return true;
        }

        const ch = await getTextChannel(channelId);
        if (!ch) {
          await interaction.reply({ content: "❌ Target channel not accessible.", ephemeral: true }).catch(() => {});
          return true;
        }

        const e = new EmbedBuilder().setTitle(title).setDescription(body).setColor(COLOR_ACCENT).setTimestamp();
        if (footer?.trim()) e.setFooter({ text: footer.trim().slice(0, 256) });

        const parsedColor = parseColor(imageOrColor, COLOR_ACCENT);
        if (parsedColor === null && imageOrColor?.trim()) {
          const possibleUrl = imageOrColor.trim();
          if (/^https?:\/\//i.test(possibleUrl)) e.setImage(possibleUrl);
        } else if (typeof parsedColor === "number") {
          e.setColor(parsedColor);
        }

        const msg = await ch.send({ embeds: [e] }).catch(() => null);
        if (!msg) {
          await interaction.reply({ content: "❌ Failed to post embed in target channel.", ephemeral: true }).catch(() => {});
          return true;
        }

        await interaction.reply({ content: `✅ Embed posted in <#${ch.id}>.`, ephemeral: true }).catch(() => {});
        return true;
      }

      return false;
    } catch (e) {
      console.error("embedpanel handleInteraction error:", e?.message || e);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "❌ Embed panel error (check terminal).", ephemeral: true }).catch(() => {});
      }
      return true;
    }
  }

  function onReady() {
    upsertPanelMessage().catch(() => {});
  }

  return { onReady, handleInteraction };
}

module.exports = { createEmbedPanelSystem };
