"use strict";

/**
 * SPIRALS Suggestions System (v1)
 * - Premium panel embed + button
 * - Modal submission by anyone
 * - Suggestion posts (bot-only) + thread per suggestion (auto-archive 3 days)
 * - One vote per user (changeable)
 * - Staff-only status buttons (Under Review / Accepted / Declined / Lock)
 * - Persistent storage in ./data/suggestions.json
 */

const fs = require("fs");
const path = require("path");

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
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
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {}
    console.error("suggestions saveJson error:", e?.message || e);
  }
}

function nowMs() {
  return Date.now();
}

function tag(uid) {
  return `<@${uid}>`;
}

function isStaff(interaction, staffRoleId) {
  if (!staffRoleId) return interaction.memberPermissions?.has("Administrator");
  return interaction.member?.roles?.cache?.has(staffRoleId) || interaction.memberPermissions?.has("Administrator");
}

function safeInt(x, fallback = 0) {
  const n = parseInt(String(x ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

// ---------- Factory ----------
function createSuggestionSystem(client, commandsDef, opts = {}) {
  const BRAND = opts.BRAND || "🌀 SPIRALS 3X";
  const FOOTER = opts.FOOTER || "🌀 SPIRALS 3X • Community Ideas";
  const COLOR_PRIMARY = opts.COLOR_PRIMARY ?? 0x00e5ff;
  const COLOR_ACCENT = opts.COLOR_ACCENT ?? 0xb100ff;
  const COLOR_NEUTRAL = opts.COLOR_NEUTRAL ?? 0x0a1020;

  // Primary emoji: 🔮
  const EMOJI = "🔮";

  // ENV / config
  const DATA_DIR = opts.DATA_DIR || path.join(__dirname, "data");
  const SUG_FILE = path.join(DATA_DIR, "suggestions.json");

  const SUGGESTIONS_CHANNEL_ID = opts.SUGGESTIONS_CHANNEL_ID || process.env.SUGGESTIONS_CHANNEL_ID || "";
  const SUGGESTIONS_PANEL_CHANNEL_ID =
    opts.SUGGESTIONS_PANEL_CHANNEL_ID || process.env.SUGGESTIONS_PANEL_CHANNEL_ID || "";
  const STAFF_ROLE_ID = opts.STAFF_ROLE_ID || process.env.STAFF_ROLE_ID || "";
  const SUGGESTION_PING_ROLE_ID = opts.SUGGESTION_PING_ROLE_ID || process.env.SUGGESTION_PING_ROLE_ID || "";
  const SUGGESTION_ACTIVE_DAYS = safeInt(opts.SUGGESTION_ACTIVE_DAYS || process.env.SUGGESTION_ACTIVE_DAYS || 3, 3);

  // 3 days = 4320 minutes for thread auto-archive
  const THREAD_AUTO_ARCHIVE_MIN = Math.min(10080, Math.max(60, SUGGESTION_ACTIVE_DAYS * 24 * 60));

  // Persistent DB
  const db = loadJsonSafe(SUG_FILE, {
    meta: { nextId: 1 },
    suggestions: {}, // id -> { id, createdAt, authorId, content, channelId, messageId, threadId, status, lockedAt, votes: { userId: -1|1 } }
  });

  function saveDb() {
    saveJson(SUG_FILE, db);
  }

  function nextId() {
    const id = db.meta.nextId || 1;
    db.meta.nextId = id + 1;
    saveDb();
    return id;
  }

  function pingRoleText() {
    return SUGGESTION_PING_ROLE_ID ? `<@&${SUGGESTION_PING_ROLE_ID}>` : "";
  }

  function header(title) {
    // match your race style, but premium + calmer
    return `**${title}** • ${BRAND} • ${EMOJI} SUGGESTIONS`;
  }

  function statusBadge(status) {
    switch (status) {
      case "UNDER_REVIEW":
        return "🟡 UNDER REVIEW";
      case "ACCEPTED":
        return "🟢 ACCEPTED";
      case "DECLINED":
        return "🔴 DECLINED";
      case "LOCKED":
        return "⚫ LOCKED";
      default:
        return "🟣 OPEN";
    }
  }

  function countVotes(votes) {
    let up = 0;
    let down = 0;
    for (const v of Object.values(votes || {})) {
      if (v === 1) up++;
      if (v === -1) down++;
    }
    return { up, down };
  }

  function buildPanelEmbed() {
    return new EmbedBuilder()
      .setColor(COLOR_ACCENT)
      .setTitle(`${EMOJI} Suggestions Dock — ${BRAND}`)
      .setDescription(
        `${header("WELCOME")}\n\n` +
          `Got an idea that could make **SPIRALS** better?\n` +
          `Drop it here — every suggestion becomes a premium card with a **3-day** live discussion window.\n\n` +
          `**How it works**\n` +
          `• Submit using the button below\n` +
          `• One vote per member (you can change it)\n` +
          `• Discussion stays open for **${SUGGESTION_ACTIVE_DAYS} days**\n\n` +
          `**Guidelines**\n` +
          `• One clear idea per suggestion\n` +
          `• Be constructive (quality > quantity)\n` +
          `• No spam or joke submissions\n\n` +
          `📡 Want to browse? Head to <#${SUGGESTIONS_CHANNEL_ID}>`
      )
      .setFooter({ text: FOOTER });
  }

  function buildPanelComponents() {
    return [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("sug:openModal")
          .setLabel("Submit a Suggestion")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId("sug:viewBoard")
          .setLabel("View Live Board")
          .setStyle(ButtonStyle.Secondary)
      ),
    ];
  }

  function buildSuggestionEmbed(sug) {
    const { up, down } = countVotes(sug.votes);
    const createdTs = Math.floor((sug.createdAt || nowMs()) / 1000);

    return new EmbedBuilder()
      .setColor(sug.status === "ACCEPTED" ? COLOR_PRIMARY : sug.status === "DECLINED" ? 0x2a0010 : COLOR_NEUTRAL)
      .setTitle(`${EMOJI} Suggestion #${String(sug.id).padStart(3, "0")}`)
      .setDescription(
        `${header("SIGNAL RECEIVED")}\n\n` +
          `> ${String(sug.content || "").trim().slice(0, 1800)}\n\n` +
          `**Status:** ${statusBadge(sug.status)}\n` +
          `**Submitted by:** ${tag(sug.authorId)}\n` +
          `**Created:** <t:${createdTs}:R>\n\n` +
          `🧵 **Discussion:** ${sug.threadId ? `<#${sug.threadId}>` : "_Creating…_"}`
      )
      .addFields(
        { name: "Votes", value: `👍 **${up}**   👎 **${down}**`, inline: true },
        { name: "Window", value: `💬 Active for **${SUGGESTION_ACTIVE_DAYS} days**`, inline: true }
      )
      .setFooter({ text: FOOTER });
  }

  function buildSuggestionComponents(sug, staffOnly = false) {
    const disabled = sug.status === "LOCKED";
    const voteRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`sug:vote:up:${sug.id}`)
        .setLabel("Upvote")
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(`sug:vote:down:${sug.id}`)
        .setLabel("Downvote")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(`sug:vote:clear:${sug.id}`)
        .setLabel("Clear Vote")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled)
    );

    if (staffOnly) return [voteRow];

    const staffRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`sug:status:review:${sug.id}`)
        .setLabel("Under Review")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`sug:status:accept:${sug.id}`)
        .setLabel("Accept")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`sug:status:decline:${sug.id}`)
        .setLabel("Decline")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`sug:status:lock:${sug.id}`)
        .setLabel("Lock")
        .setStyle(ButtonStyle.Primary)
    );

    return [voteRow, staffRow];
  }

  async function getSuggestionsChannel(guild) {
    if (!SUGGESTIONS_CHANNEL_ID) return null;
    const ch = await guild.channels.fetch(SUGGESTIONS_CHANNEL_ID).catch(() => null);
    if (!ch) return null;
    if (!("send" in ch)) return null;
    return ch;
  }

  async function createSuggestion(interaction, content) {
    const guild = interaction.guild;
    if (!guild) return;

    const sugCh = await getSuggestionsChannel(guild);
    if (!sugCh) {
      return interaction.reply({
        content: `❌ Suggestions channel not set. Ask staff to set \`SUGGESTIONS_CHANNEL_ID\` in .env.`,
        ephemeral: true,
      });
    }

    const id = nextId();
    const sug = {
      id,
      createdAt: nowMs(),
      authorId: interaction.user.id,
      content: String(content || "").trim(),
      channelId: sugCh.id,
      messageId: null,
      threadId: null,
      status: "OPEN",
      lockedAt: null,
      votes: {},
    };

    // Optional ping (you said you’ll add later—this is already wired)
    const ping = pingRoleText();
    const pingLine = ping ? `${ping}\n\n` : "";

    const msg = await sugCh
      .send({
        content: pingLine,
        embeds: [buildSuggestionEmbed(sug)],
        components: buildSuggestionComponents(sug, false),
      })
      .catch(() => null);

    if (!msg) {
      return interaction.reply({ content: "❌ Failed to post suggestion (missing perms?).", ephemeral: true });
    }

    sug.messageId = msg.id;

    // Create thread under the suggestion message
    const thread = await msg
      .startThread({
        name: `${EMOJI} Suggestion #${String(id).padStart(3, "0")} • Discussion`,
        autoArchiveDuration: THREAD_AUTO_ARCHIVE_MIN, // 3 days
        reason: "SPIRALS Suggestions discussion thread",
      })
      .catch(() => null);

    if (thread) {
      sug.threadId = thread.id;

      await thread
        .send({
          content:
            `${header("DISCUSSION THREAD")}\n\n` +
            `💬 This thread stays open for **${SUGGESTION_ACTIVE_DAYS} days**.\n` +
            `Keep it constructive. Staff will update the status on the main card.\n\n` +
            `**Submitted by:** ${tag(sug.authorId)}`,
        })
        .catch(() => {});
    }

    db.suggestions[String(id)] = sug;
    saveDb();

    // Edit main card to include thread reference if created
    await msg
      .edit({
        embeds: [buildSuggestionEmbed(sug)],
        components: buildSuggestionComponents(sug, false),
      })
      .catch(() => {});

    // Acknowledge to user
    return interaction.reply({
      content: `✅ ${EMOJI} Suggestion submitted as **#${String(id).padStart(3, "0")}** in <#${sugCh.id}>.`,
      ephemeral: true,
    });
  }

  async function updateSuggestionMessage(guild, sug) {
    if (!sug?.channelId || !sug?.messageId) return;
    const ch = await guild.channels.fetch(sug.channelId).catch(() => null);
    if (!ch || !("messages" in ch)) return;

    const msg = await ch.messages.fetch(sug.messageId).catch(() => null);
    if (!msg) return;

    await msg
      .edit({
        embeds: [buildSuggestionEmbed(sug)],
        components: buildSuggestionComponents(sug, false),
      })
      .catch(() => {});
  }

  async function lockSuggestion(guild, sug, reason = "Discussion window closed.") {
    if (!sug || sug.status === "LOCKED") return;
    sug.status = "LOCKED";
    sug.lockedAt = nowMs();
    saveDb();

    // lock thread if possible
    if (sug.threadId) {
      const t = await guild.channels.fetch(sug.threadId).catch(() => null);
      if (t && t.type === ChannelType.PublicThread) {
        await t.send({ content: `⚫ **Locked:** ${reason}` }).catch(() => {});
        await t.setLocked(true).catch(() => {});
        await t.setArchived(true).catch(() => {});
      }
    }

    await updateSuggestionMessage(guild, sug);
  }

  // Sweep (survives restarts): lock anything older than N days and not already locked
  async function sweepLocks() {
    try {
      // client ready?
      if (!client.isReady()) return;

      const guilds = client.guilds.cache;
      for (const [, guild] of guilds) {
        for (const [id, sug] of Object.entries(db.suggestions || {})) {
          if (!sug || sug.status === "LOCKED") continue;
          const ageMs = nowMs() - (sug.createdAt || nowMs());
          const limitMs = SUGGESTION_ACTIVE_DAYS * 24 * 60 * 60 * 1000;
          if (ageMs >= limitMs) {
            await lockSuggestion(guild, sug, "3-day discussion window ended.");
          }
        }
      }
    } catch (e) {
      console.log("suggestions sweep error:", e?.message || e);
    }
  }

  // Commands
  const cmdPanel = new SlashCommandBuilder()
    .setName("suggestionspanel")
    .setDescription("Post the premium suggestions panel (admin)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

  // Register commands (push actual SlashCommandBuilder objects)
  commandsDef.push(cmdPanel);

  // Handle interactions
  async function handleInteraction(interaction) {
    try {
      // Slash command: /suggestionspanel
      if (interaction.isChatInputCommand() && interaction.commandName === "suggestionspanel") {
        const guild = interaction.guild;
        if (!guild) return true;

        // Prefer PANEL channel env if set, else current channel
        const targetId = SUGGESTIONS_PANEL_CHANNEL_ID || interaction.channelId;
        const ch = await guild.channels.fetch(targetId).catch(() => null);
        if (!ch || !("send" in ch)) {
          await interaction.reply({ content: "❌ Panel channel not found / not writable.", ephemeral: true });
          return true;
        }

        await ch
          .send({
            embeds: [buildPanelEmbed()],
            components: buildPanelComponents(),
          })
          .catch(() => null);

        await interaction.reply({ content: `✅ Posted the ${EMOJI} Suggestions panel in <#${ch.id}>.`, ephemeral: true });
        return true;
      }

      // Panel buttons
      if (interaction.isButton()) {
        const id = interaction.customId || "";

        if (id === "sug:viewBoard") {
          if (!SUGGESTIONS_CHANNEL_ID) {
            await interaction.reply({ content: "❌ Suggestions board not set in .env.", ephemeral: true });
            return true;
          }
          await interaction.reply({ content: `📡 Live board: <#${SUGGESTIONS_CHANNEL_ID}>`, ephemeral: true });
          return true;
        }

        if (id === "sug:openModal") {
          const modal = new ModalBuilder().setCustomId("sug:modal:submit").setTitle(`${EMOJI} Submit a Suggestion`);

          const input = new TextInputBuilder()
            .setCustomId("sug:modal:content")
            .setLabel("What would you like to suggest?")
            .setStyle(TextInputStyle.Paragraph)
            .setMinLength(10)
            .setMaxLength(900)
            .setPlaceholder("Be clear + specific. One idea per submission.")
            .setRequired(true);

          modal.addComponents(new ActionRowBuilder().addComponents(input));
          await interaction.showModal(modal);
          return true;
        }

        // Voting & status
        if (id.startsWith("sug:vote:") || id.startsWith("sug:status:")) {
          const parts = id.split(":");
          // vote: sug:vote:(up|down|clear):ID
          // status: sug:status:(review|accept|decline|lock):ID
          const type = parts[1];
          const action = parts[2];
          const sugId = parts[3];
          const sug = db.suggestions[String(sugId)];
          if (!sug) {
            await interaction.reply({ content: "❌ That suggestion no longer exists.", ephemeral: true });
            return true;
          }

          // Votes
          if (type === "vote") {
            if (sug.status === "LOCKED") {
              await interaction.reply({ content: "⚫ This suggestion is locked.", ephemeral: true });
              return true;
            }
            const uid = interaction.user.id;
            if (action === "up") sug.votes[uid] = 1;
            if (action === "down") sug.votes[uid] = -1;
            if (action === "clear") delete sug.votes[uid];
            saveDb();

            await updateSuggestionMessage(interaction.guild, sug);

            // Silent-ish confirmation
            const { up, down } = countVotes(sug.votes);
            await interaction.reply({ content: `✅ Vote recorded. 👍 ${up} | 👎 ${down}`, ephemeral: true });
            return true;
          }

          // Staff status
          if (type === "status") {
            if (!isStaff(interaction, STAFF_ROLE_ID)) {
              await interaction.reply({ content: "❌ Staff only.", ephemeral: true });
              return true;
            }

            if (action === "review") sug.status = "UNDER_REVIEW";
            if (action === "accept") sug.status = "ACCEPTED";
            if (action === "decline") sug.status = "DECLINED";
            if (action === "lock") {
              await lockSuggestion(interaction.guild, sug, "Locked by staff.");
              await interaction.reply({ content: "⚫ Locked.", ephemeral: true });
              return true;
            }

            saveDb();
            await updateSuggestionMessage(interaction.guild, sug);
            await interaction.reply({ content: `✅ Status set to **${statusBadge(sug.status)}**`, ephemeral: true });
            return true;
          }
        }
      }

      // Modal submit
      if (interaction.isModalSubmit() && interaction.customId === "sug:modal:submit") {
        const content = interaction.fields.getTextInputValue("sug:modal:content");
        if (!content || String(content).trim().length < 10) {
          await interaction.reply({ content: "❌ Please write a more detailed suggestion.", ephemeral: true });
          return true;
        }
        await createSuggestion(interaction, content);
        return true;
      }

      return false;
    } catch (e) {
      console.log("suggestions handleInteraction error:", e?.message || e);
      try {
        if (interaction && !interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: "❌ Suggestion system error (check logs).", ephemeral: true });
        }
      } catch {}
      return true;
    }
  }

  // Start sweeper on ready + interval
  client.once("ready", async () => {
    await sweepLocks();
    setInterval(sweepLocks, 15 * 60 * 1000); // every 15 minutes
  });

  return { handleInteraction };
}

module.exports = { createSuggestionSystem };
