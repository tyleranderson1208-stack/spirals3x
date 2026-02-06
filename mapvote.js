"use strict";

/**
 * Map Vote System (Discord.js v14)
 * - /mapvotepanel (admin) posts panel
 * - One vote per user (changing vote overwrites)
 * - Persistent JSON: data/mapvote.json
 * - Live results edit on same message
 */

const fs = require("fs");
const path = require("path");

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

// ========= CONFIG / THEME =========
const BRAND = "🌀 SPIRALS 3X";
const COLOR_PRIMARY = 0x00e5ff; // neon cyan
const COLOR_ACCENT = 0xb100ff; // neon purple
const COLOR_DARK = 0x050012;

const FOOTER = process.env.UI_FOOTER || "🌀 SPIRALS 3X";

const MAPVOTE_CHANNEL_ID = process.env.MAPVOTE_CHANNEL_ID || "";
const MAPVOTE_PING_ROLE_ID = process.env.MAPVOTE_PING_ROLE_ID || "";
const MAPVOTE_TITLE = process.env.MAPVOTE_TITLE || "🗳️ Map Vote — Choose the Next Wipe";
const MAPVOTE_DESC =
  process.env.MAPVOTE_DESC ||
  "Your selection becomes part of the Spiral.\nOne vote per member — you may change your vote at any time.";
const MAPVOTE_DURATION_HOURS = Math.max(1, parseInt(process.env.MAPVOTE_DURATION_HOURS || "72", 10) || 72);

// Provide maps in .env as comma-separated:
// MAPVOTE_MAPS=Procedural,Arctic,Desert,Islands,Coastal
function getMapsFromEnv() {
  const raw = (process.env.MAPVOTE_MAPS || "").trim();
  if (!raw) {
    // sensible defaults if env missing
    return ["Procedural", "Arctic", "Desert", "Islands", "Coastal"];
  }
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 25); // Discord select limit
}

// ========= DATA STORAGE =========
const DATA_DIR = path.join(__dirname, "data");
const FILE = path.join(DATA_DIR, "mapvote.json");

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
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {}
    console.error("[mapvote] saveJson error:", e?.message || e);
  }
}

const db = loadJsonSafe(FILE, {
  active: null, // { guildId, channelId, messageId, createdAt, closesAt, closed, maps: [], votes: { userId: mapName } }
});

function header(title) {
  return `**${title}** • ${BRAND}`;
}
function rolePingText() {
  return MAPVOTE_PING_ROLE_ID ? `<@&${MAPVOTE_PING_ROLE_ID}>` : "";
}

// ========= BUILD UI =========
function tallyVotes(state) {
  const counts = {};
  for (const m of state.maps) counts[m] = 0;
  for (const uid of Object.keys(state.votes || {})) {
    const choice = state.votes[uid];
    if (choice && counts[choice] !== undefined) counts[choice] += 1;
  }
  // sort by votes desc then name
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return rows;
}

function formatResults(state) {
  const rows = tallyVotes(state);
  const total = Object.keys(state.votes || {}).length;

  if (!rows.length) return "`No options loaded.`";
  if (total === 0) {
    return rows.map(([name]) => `• **${name}** — \`0\``).join("\n");
  }

  const max = Math.max(...rows.map(([, c]) => c), 1);
  const bar = (n) => {
    const blocks = Math.round((n / max) * 10);
    return "▰".repeat(blocks) + "▱".repeat(10 - blocks);
  };

  return rows
    .map(([name, c]) => `• **${name}** — \`${c}\`  ${bar(c)}`)
    .join("\n");
}

function buildPanelEmbed(state) {
  const isClosed = !!state.closed;
  const closesAt = state.closesAt || (state.createdAt + MAPVOTE_DURATION_HOURS * 3600);

  return new EmbedBuilder()
    .setColor(isClosed ? COLOR_DARK : COLOR_ACCENT)
    .setTitle(MAPVOTE_TITLE)
    .setDescription(
      `${header("THE SPIRAL DECIDES")}\n\n` +
        `${MAPVOTE_DESC}\n\n` +
        `⏳ **Closes:** ${isClosed ? "**Closed**" : `<t:${closesAt}:R>`}\n` +
        `👥 **Votes cast:** \`${Object.keys(state.votes || {}).length}\`\n\n` +
        `**Live Results:**\n${formatResults(state)}`
    )
    .setFooter({ text: FOOTER });
}

function buildSelectRow(state) {
  const isClosed = !!state.closed;
  const menu = new StringSelectMenuBuilder()
    .setCustomId("mapvote:select")
    .setPlaceholder(isClosed ? "Voting is closed" : "Choose a map…")
    .setMinValues(1)
    .setMaxValues(1)
    .setDisabled(isClosed);

  for (const m of state.maps) {
    menu.addOptions({ label: m, value: m });
  }

  return new ActionRowBuilder().addComponents(menu);
}

function buildButtonsRow(state) {
  const isClosed = !!state.closed;

  const refresh = new ButtonBuilder()
    .setCustomId("mapvote:refresh")
    .setLabel("Refresh")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(false);

  const close = new ButtonBuilder()
    .setCustomId("mapvote:close")
    .setLabel(isClosed ? "Closed" : "Close Vote")
    .setStyle(ButtonStyle.Danger)
    .setDisabled(isClosed);

  return new ActionRowBuilder().addComponents(refresh, close);
}

// ========= CORE =========
async function safeFetchChannel(client, channelId) {
  if (!channelId) return null;
  return client.channels.fetch(channelId).catch(() => null);
}

async function safeFetchMessage(channel, messageId) {
  if (!channel || !messageId || !("messages" in channel)) return null;
  return channel.messages.fetch(messageId).catch(() => null);
}

async function upsertPanelMessage(client) {
  const state = db.active;
  if (!state) return;

  const channel = await safeFetchChannel(client, state.channelId);
  if (!channel) return;

  const msg = await safeFetchMessage(channel, state.messageId);
  if (!msg) return;

  await msg
    .edit({
      embeds: [buildPanelEmbed(state)],
      components: [buildSelectRow(state), buildButtonsRow(state)],
    })
    .catch(() => {});
}

function ensureActive(guildId) {
  const maps = getMapsFromEnv();
  if (!db.active || db.active.guildId !== guildId) {
    db.active = {
      guildId,
      channelId: MAPVOTE_CHANNEL_ID || null,
      messageId: null,
      createdAt: Math.floor(Date.now() / 1000),
      closesAt: Math.floor(Date.now() / 1000) + MAPVOTE_DURATION_HOURS * 3600,
      closed: false,
      maps,
      votes: {},
    };
    saveJson(FILE, db);
  } else {
    // keep maps synced (without wiping votes unless map removed)
    db.active.maps = maps;
    saveJson(FILE, db);
  }
  return db.active;
}

async function postPanel(interactionOrChannel, client) {
  const guild = interactionOrChannel.guild;
  const guildId = guild.id;

  const state = ensureActive(guildId);

  const channelId =
    interactionOrChannel.channelId ||
    interactionOrChannel.id ||
    MAPVOTE_CHANNEL_ID ||
    null;

  state.channelId = channelId;

  const channel = await safeFetchChannel(client, channelId);
  if (!channel || !("send" in channel)) {
    throw new Error("MAPVOTE_CHANNEL_ID invalid or not a text channel.");
  }

  const ping = rolePingText();
  if (ping) {
    await channel.send({ content: ping }).catch(() => {});
  }

  const sent = await channel.send({
    embeds: [buildPanelEmbed(state)],
    components: [buildSelectRow(state), buildButtonsRow(state)],
  });

  state.messageId = sent.id;
  saveJson(FILE, db);

  return sent;
}

function isAdminish(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
}

async function handleInteraction(interaction, client) {
  try {
    // only care about mapvote interactions
    const id = interaction.customId || "";
    const isSelect = interaction.isStringSelectMenu?.() && id === "mapvote:select";
    const isBtn = interaction.isButton?.() && id.startsWith("mapvote:");
    if (!isSelect && !isBtn) return false;

    const guildId = interaction.guildId;
    if (!guildId) return true;

    const state = ensureActive(guildId);

    // auto-close check
    const now = Math.floor(Date.now() / 1000);
    if (!state.closed && state.closesAt && now >= state.closesAt) {
      state.closed = true;
      saveJson(FILE, db);
    }

    // SELECT: vote
    if (isSelect) {
      if (state.closed) {
        await interaction.reply({ content: "🌀 Voting is closed.", ephemeral: true }).catch(() => {});
        return true;
      }

      const choice = interaction.values?.[0];
      if (!choice || !state.maps.includes(choice)) {
        await interaction.reply({ content: "❌ Invalid choice.", ephemeral: true }).catch(() => {});
        return true;
      }

      state.votes[interaction.user.id] = choice;
      saveJson(FILE, db);

      await interaction.reply({
        content: `✅ Your vote is sealed: **${choice}**`,
        ephemeral: true,
      }).catch(() => {});

      await upsertPanelMessage(client);
      return true;
    }

    // BUTTONS
    if (isBtn) {
      const action = id.split(":")[1];

      if (action === "refresh") {
        await interaction.deferUpdate().catch(() => {});
        await upsertPanelMessage(client);
        return true;
      }

      if (action === "close") {
        if (!isAdminish(interaction)) {
          await interaction.reply({ content: "❌ Admin only.", ephemeral: true }).catch(() => {});
          return true;
        }

        state.closed = true;
        saveJson(FILE, db);

        await interaction.reply({ content: "🧿 Vote closed. Results are locked.", ephemeral: true }).catch(() => {});
        await upsertPanelMessage(client);
        return true;
      }
    }

    return true;
  } catch (e) {
    console.error("[mapvote] handleInteraction error:", e?.message || e);
    try {
      if (!interaction.replied) {
        await interaction.reply({ content: "❌ Map vote error (check logs).", ephemeral: true });
      }
    } catch {}
    return true;
  }
}

// ========= EXPORT / COMMANDS =========
function createMapVoteSystem(client, commandsDef) {
  const cmd = new SlashCommandBuilder()
    .setName("mapvotepanel")
    .setDescription("Post (or repost) the SPIRALS map vote panel (admin).")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

  const commands = [cmd];

  // If your bot uses commandsDef aggregation:
  if (Array.isArray(commandsDef)) commandsDef.push(...commands);

  // optional: background auto-close refresh loop
  setInterval(async () => {
    try {
      const state = db.active;
      if (!state || state.closed) return;

      const now = Math.floor(Date.now() / 1000);
      if (state.closesAt && now >= state.closesAt) {
        state.closed = true;
        saveJson(FILE, db);
        await upsertPanelMessage(client);
      }
    } catch {}
  }, 30_000);

  return {
    commands,
    handleInteraction: (interaction) => handleInteraction(interaction, client),
    postPanel: async (channelOrInteraction) => postPanel(channelOrInteraction, client),
  };
}

module.exports = { createMapVoteSystem };
