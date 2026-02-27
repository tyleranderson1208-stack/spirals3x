"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  PermissionsBitField,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const BRAND = "🌀 SPIRALS 3X";
const COLOR_PRIMARY = 0xb100ff;
const COLOR_ACCENT = 0x00e5ff;

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function clean(input, max = 400) {
  return String(input || "").trim().slice(0, max);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadJson(file, fallback) {
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

function defaultData() {
  return {
    config: {
      giveawayChannelId: null,
      logChannelId: null,
      defaultPingRoleId: null,
      panelChannelId: null,
      panelMessageId: null,
      remindersEnabled: true,
    },
    giveaways: {},
  };
}

function isAdmin(interaction) {
  return interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);
}

async function getTextChannel(client, id) {
  if (!id) return null;
  const ch = await client.channels.fetch(id).catch(() => null);
  if (!ch || !("send" in ch)) return null;
  return ch;
}

function chooseWinners(ids, count) {
  const pool = ids.slice();
  const out = [];
  while (pool.length && out.length < count) {
    const idx = Math.floor(Math.random() * pool.length);
    out.push(pool[idx]);
    pool.splice(idx, 1);
  }
  return out;
}

function createGiveawaySystem(client, commandsDef = [], opts = {}) {
  const DATA_DIR = opts.DATA_DIR ? path.resolve(opts.DATA_DIR) : path.join(__dirname, "data");
  const DATA_FILE = path.join(DATA_DIR, "giveaways.json");
  const FOOTER = process.env.UI_FOOTER || `${BRAND} • Giveaway Systems Online`;

  let data = loadJson(DATA_FILE, defaultData());
  (function patch() {
    const base = defaultData();
    data.config = { ...base.config, ...(data.config || {}) };
    data.giveaways = data.giveaways && typeof data.giveaways === "object" ? data.giveaways : {};
    saveJson(DATA_FILE, data);
  })();

  function giveawayButtons(g, closed = false) {
    return [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`gw:enter:${g.id}`)
          .setStyle(ButtonStyle.Success)
          .setEmoji("🎁")
          .setLabel(`Enter • ${g.entrantIds.length}`)
          .setDisabled(closed),
        new ButtonBuilder()
          .setCustomId(`gw:leave:${g.id}`)
          .setStyle(ButtonStyle.Secondary)
          .setEmoji("↩️")
          .setLabel("Leave")
          .setDisabled(closed)
      ),
    ];
  }

  function giveawayEmbed(g) {
    const entries = g.entrantIds.length;
    const closed = !!g.endedAtUnix;
    const status = closed ? "🔒 Closed" : "🟢 Live";

    const eligibility = [
      g.requiredRoleId ? `• Required role: <@&${g.requiredRoleId}>` : "• Required role: none",
      g.bonusRoleId ? `• Bonus entry role: <@&${g.bonusRoleId}> (+1 draw weight)` : "• Bonus role: none",
      g.minAccountDays > 0 ? `• Account age: at least ${g.minAccountDays} day(s)` : "• Account age: any",
      g.minServerDays > 0 ? `• Server age: at least ${g.minServerDays} day(s)` : "• Server age: any",
    ].join("\n");

    const e = new EmbedBuilder()
      .setColor(COLOR_PRIMARY)
      .setTitle(`🎁 ${BRAND} — GIVEAWAY ${closed ? "RESULTS" : "LIVE"}`)
      .setDescription(
        [
          `**Prize:** ${g.prize}`,
          `**Status:** ${status}`,
          closed ? `**Ended:** <t:${g.endedAtUnix}:F> (<t:${g.endedAtUnix}:R>)` : `**Ends:** <t:${g.endsAtUnix}:F> (<t:${g.endsAtUnix}:R>)`,
          `**Winners:** \`${g.winnerCount}\``,
          `**Entries:** \`${entries}\``,
          "",
          "Tap **Enter** to join. This giveaway runs exclusively in the giveaway channel.",
        ].join("\n")
      )
      .addFields(
        { name: "Eligibility", value: eligibility, inline: false },
        {
          name: "Visual Style",
          value: `Banner: ${g.bannerImageUrl ? "✅" : "—"}\nThumbnail: ${g.thumbImageUrl ? "✅" : "—"}`,
          inline: true,
        }
      )
      .setFooter({ text: FOOTER })
      .setTimestamp();

    if (g.bannerImageUrl) e.setImage(g.bannerImageUrl);
    if (g.thumbImageUrl) e.setThumbnail(g.thumbImageUrl);
    return e;
  }

  function panelEmbed() {
    return new EmbedBuilder()
      .setColor(COLOR_ACCENT)
      .setTitle(`🎛️ ${BRAND} — GIVEAWAY CONTROL PANEL`)
      .setDescription(
        [
          "Staff quick-launch panel for giveaways.",
          "",
          "**Recommended flow**",
          "1) Run `/giveaway-start` with prize + timing + visuals",
          "2) Let users join via buttons",
          "3) Use `/giveaway-end` or allow auto-close",
          "4) Use `/giveaway-reroll` if needed",
        ].join("\n")
      )
      .addFields(
        { name: "Configured Giveaway Channel", value: data.config.giveawayChannelId ? `<#${data.config.giveawayChannelId}>` : "`Not set`" },
        { name: "Log Channel", value: data.config.logChannelId ? `<#${data.config.logChannelId}>` : "`Not set`" },
        { name: "Default Ping Role", value: data.config.defaultPingRoleId ? `<@&${data.config.defaultPingRoleId}>` : "`None`" }
      )
      .setFooter({ text: FOOTER })
      .setTimestamp();
  }

  async function refreshPanel() {
    const { panelChannelId, panelMessageId } = data.config;
    if (!panelChannelId || !panelMessageId) return;
    const ch = await getTextChannel(client, panelChannelId);
    if (!ch || !("messages" in ch)) return;
    const msg = await ch.messages.fetch(panelMessageId).catch(() => null);
    if (!msg) return;
    await msg.edit({ embeds: [panelEmbed()] }).catch(() => {});
  }

  function logEmbed(title, desc) {
    return new EmbedBuilder().setColor(COLOR_ACCENT).setTitle(title).setDescription(desc).setFooter({ text: FOOTER }).setTimestamp();
  }

  async function postLog(embed) {
    const ch = await getTextChannel(client, data.config.logChannelId);
    if (!ch) return;
    await ch.send({ embeds: [embed] }).catch(() => {});
  }

  async function endGiveaway(g, reason = "Auto-complete") {
    if (g.endedAtUnix) return;

    const weighted = [];
    for (const id of g.entrantIds) {
      weighted.push(id);
      if (g.bonusRoleId && g.bonusEntrantIds.includes(id)) weighted.push(id);
    }
    const winners = chooseWinners([...new Set(weighted)], g.winnerCount);

    g.endedAtUnix = nowUnix();
    g.winnerIds = winners;

    const ch = await getTextChannel(client, g.channelId);
    if (ch && "messages" in ch) {
      const msg = await ch.messages.fetch(g.messageId).catch(() => null);
      if (msg) {
        await msg
          .edit({
            embeds: [giveawayEmbed(g)],
            components: giveawayButtons(g, true),
          })
          .catch(() => {});
      }

      const winnerText = winners.length ? winners.map((id) => `<@${id}>`).join(", ") : "No eligible winners.";
      await ch
        .send({
          content: `🏆 **Giveaway ended** — ${g.prize}`,
          embeds: [
            logEmbed(
              `🏁 ${BRAND} — GIVEAWAY COMPLETE`,
              `**Prize:** ${g.prize}\n**Reason:** ${reason}\n**Entries:** \`${g.entrantIds.length}\`\n**Winners:** ${winnerText}`
            ),
          ],
        })
        .catch(() => {});
    }

    await postLog(
      logEmbed(
        `🎁 Giveaway Ended`,
        `ID: \`${g.id}\`\nPrize: ${g.prize}\nReason: ${reason}\nWinners: ${g.winnerIds.map((id) => `<@${id}>`).join(", ") || "none"}`
      )
    );

    data.giveaways[g.id] = g;
    saveJson(DATA_FILE, data);
  }

  function canEnter(g, interaction) {
    const member = interaction.member;
    if (!member) return "Member data unavailable.";

    if (g.requiredRoleId && !member.roles?.cache?.has(g.requiredRoleId)) {
      return `You need the role <@&${g.requiredRoleId}> to enter this giveaway.`;
    }

    const userCreated = Math.floor(new Date(interaction.user.createdAt).getTime() / 1000);
    const accountDays = Math.floor((nowUnix() - userCreated) / 86400);
    if (g.minAccountDays > 0 && accountDays < g.minAccountDays) {
      return `Your account must be at least ${g.minAccountDays} day(s) old to enter.`;
    }

    const joinedTs = interaction.member?.joinedTimestamp ? Math.floor(interaction.member.joinedTimestamp / 1000) : null;
    const serverDays = joinedTs ? Math.floor((nowUnix() - joinedTs) / 86400) : 0;
    if (g.minServerDays > 0 && serverDays < g.minServerDays) {
      return `You must be in the server for at least ${g.minServerDays} day(s) to enter.`;
    }

    return null;
  }

  async function handleButton(interaction) {
    if (!interaction.isButton() || !interaction.customId.startsWith("gw:")) return false;

    const match = interaction.customId.match(/^gw:(enter|leave):([a-f0-9]{8})$/);
    if (!match) return false;

    const [, action, id] = match;
    const g = data.giveaways[id];
    if (!g) {
      await interaction.reply({ content: "❌ Giveaway no longer exists.", ephemeral: true }).catch(() => {});
      return true;
    }

    if (g.endedAtUnix || nowUnix() >= g.endsAtUnix) {
      await endGiveaway(g, "Reached end time");
      await interaction.reply({ content: "⏳ This giveaway has ended.", ephemeral: true }).catch(() => {});
      return true;
    }

    if (action === "enter") {
      const reason = canEnter(g, interaction);
      if (reason) {
        await interaction.reply({ content: `❌ ${reason}`, ephemeral: true }).catch(() => {});
        return true;
      }

      if (!g.entrantIds.includes(interaction.user.id)) g.entrantIds.push(interaction.user.id);
      if (g.bonusRoleId && interaction.member?.roles?.cache?.has(g.bonusRoleId) && !g.bonusEntrantIds.includes(interaction.user.id)) {
        g.bonusEntrantIds.push(interaction.user.id);
      }

      data.giveaways[g.id] = g;
      saveJson(DATA_FILE, data);
      await interaction.message.edit({ embeds: [giveawayEmbed(g)], components: giveawayButtons(g, false) }).catch(() => {});
      await interaction.reply({ content: `✅ You're entered in **${g.prize}**.`, ephemeral: true }).catch(() => {});
      return true;
    }

    g.entrantIds = g.entrantIds.filter((x) => x !== interaction.user.id);
    g.bonusEntrantIds = g.bonusEntrantIds.filter((x) => x !== interaction.user.id);

    data.giveaways[g.id] = g;
    saveJson(DATA_FILE, data);
    await interaction.message.edit({ embeds: [giveawayEmbed(g)], components: giveawayButtons(g, false) }).catch(() => {});
    await interaction.reply({ content: "↩️ You left this giveaway.", ephemeral: true }).catch(() => {});
    return true;
  }

  const commands = [
    new SlashCommandBuilder()
      .setName("giveaway-setup")
      .setDescription("Configure giveaway channels/settings (admin)")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addChannelOption((o) => o.setName("giveaway_channel").setDescription("Main giveaway channel").setRequired(true))
      .addChannelOption((o) => o.setName("log_channel").setDescription("Staff log channel (optional)").setRequired(false))
      .addRoleOption((o) => o.setName("default_ping_role").setDescription("Default ping role (optional)").setRequired(false))
      .addBooleanOption((o) => o.setName("reminders").setDescription("Enable reminders").setRequired(false)),

    new SlashCommandBuilder()
      .setName("giveaway-panel")
      .setDescription("Post the giveaway control panel (admin)")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addChannelOption((o) => o.setName("channel").setDescription("Panel channel").setRequired(true)),

    new SlashCommandBuilder()
      .setName("giveaway-start")
      .setDescription("Start a fully customized giveaway (admin)")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addStringOption((o) => o.setName("prize").setDescription("Prize text").setRequired(true))
      .addIntegerOption((o) => o.setName("duration_minutes").setDescription("Duration in minutes").setRequired(true).setMinValue(1).setMaxValue(10080))
      .addIntegerOption((o) => o.setName("winners").setDescription("Number of winners").setRequired(true).setMinValue(1).setMaxValue(20))
      .addChannelOption((o) => o.setName("channel").setDescription("Override giveaway channel").setRequired(false))
      .addRoleOption((o) => o.setName("required_role").setDescription("Role required to enter").setRequired(false))
      .addRoleOption((o) => o.setName("bonus_role").setDescription("Role with bonus entry chance").setRequired(false))
      .addIntegerOption((o) => o.setName("min_account_days").setDescription("Minimum account age in days").setRequired(false).setMinValue(0).setMaxValue(3650))
      .addIntegerOption((o) => o.setName("min_server_days").setDescription("Minimum server age in days").setRequired(false).setMinValue(0).setMaxValue(3650))
      .addAttachmentOption((o) => o.setName("banner_image").setDescription("Big banner image").setRequired(false))
      .addAttachmentOption((o) => o.setName("thumb_image").setDescription("Thumbnail image").setRequired(false))
      .addRoleOption((o) => o.setName("ping_role").setDescription("Role to ping for this giveaway").setRequired(false)),

    new SlashCommandBuilder()
      .setName("giveaway-end")
      .setDescription("Force-end an active giveaway (admin)")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addStringOption((o) => o.setName("giveaway_id").setDescription("Giveaway ID from status command").setRequired(true)),

    new SlashCommandBuilder()
      .setName("giveaway-reroll")
      .setDescription("Reroll winners for ended giveaway (admin)")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addStringOption((o) => o.setName("giveaway_id").setDescription("Giveaway ID").setRequired(true))
      .addIntegerOption((o) => o.setName("winners").setDescription("How many winners to draw").setRequired(false).setMinValue(1).setMaxValue(20)),

    new SlashCommandBuilder()
      .setName("giveaway-status")
      .setDescription("Show active/ended giveaway IDs (admin)")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  ];

  if (Array.isArray(commandsDef)) commandsDef.push(...commands);

  async function handleInteraction(interaction) {
    if (await handleButton(interaction)) return true;
    if (!interaction.isChatInputCommand()) return false;

    const name = interaction.commandName;
    if (!name.startsWith("giveaway-")) return false;
    if (!isAdmin(interaction)) {
      await interaction.reply({ content: "❌ Admin only.", ephemeral: true }).catch(() => {});
      return true;
    }

    if (name === "giveaway-setup") {
      const giveawayChannel = interaction.options.getChannel("giveaway_channel", true);
      const logChannel = interaction.options.getChannel("log_channel", false);
      const role = interaction.options.getRole("default_ping_role", false);
      const reminders = interaction.options.getBoolean("reminders");

      data.config.giveawayChannelId = giveawayChannel.id;
      data.config.logChannelId = logChannel ? logChannel.id : data.config.logChannelId;
      data.config.defaultPingRoleId = role ? role.id : data.config.defaultPingRoleId;
      if (typeof reminders === "boolean") data.config.remindersEnabled = reminders;
      saveJson(DATA_FILE, data);
      await refreshPanel();

      await interaction.reply({
        content: `✅ Giveaway setup saved.\n• Giveaway channel: <#${data.config.giveawayChannelId}>\n• Log channel: ${
          data.config.logChannelId ? `<#${data.config.logChannelId}>` : "`none`"
        }\n• Default ping role: ${data.config.defaultPingRoleId ? `<@&${data.config.defaultPingRoleId}>` : "`none`"}\n• Reminders: \`${
          data.config.remindersEnabled
        }\``,
        ephemeral: true,
      });
      return true;
    }

    if (name === "giveaway-panel") {
      const ch = interaction.options.getChannel("channel", true);
      const msg = await ch.send({ embeds: [panelEmbed()] }).catch(() => null);
      if (!msg) {
        await interaction.reply({ content: "❌ Could not post panel in that channel.", ephemeral: true }).catch(() => {});
        return true;
      }
      data.config.panelChannelId = ch.id;
      data.config.panelMessageId = msg.id;
      saveJson(DATA_FILE, data);
      await interaction.reply({ content: `✅ Giveaway control panel posted in <#${ch.id}>.`, ephemeral: true }).catch(() => {});
      return true;
    }

    if (name === "giveaway-start") {
      const prize = clean(interaction.options.getString("prize", true), 200);
      const winners = interaction.options.getInteger("winners", true);
      const duration = interaction.options.getInteger("duration_minutes", true);
      const channelOpt = interaction.options.getChannel("channel", false);
      const requiredRole = interaction.options.getRole("required_role", false);
      const bonusRole = interaction.options.getRole("bonus_role", false);
      const minAccountDays = interaction.options.getInteger("min_account_days", false) || 0;
      const minServerDays = interaction.options.getInteger("min_server_days", false) || 0;
      const banner = interaction.options.getAttachment("banner_image", false);
      const thumb = interaction.options.getAttachment("thumb_image", false);
      const pingRole = interaction.options.getRole("ping_role", false);

      const outChannelId = channelOpt?.id || data.config.giveawayChannelId;
      if (!outChannelId) {
        await interaction.reply({ content: "❌ Run `/giveaway-setup` first or provide `channel`.", ephemeral: true }).catch(() => {});
        return true;
      }
      const outChannel = await getTextChannel(client, outChannelId);
      if (!outChannel) {
        await interaction.reply({ content: "❌ Giveaway channel is not accessible.", ephemeral: true }).catch(() => {});
        return true;
      }

      const id = crypto.randomBytes(4).toString("hex");
      const g = {
        id,
        guildId: interaction.guildId,
        channelId: outChannel.id,
        messageId: null,
        createdById: interaction.user.id,
        createdAtUnix: nowUnix(),
        endsAtUnix: nowUnix() + duration * 60,
        endedAtUnix: null,
        prize,
        winnerCount: winners,
        winnerIds: [],
        entrantIds: [],
        bonusEntrantIds: [],
        requiredRoleId: requiredRole?.id || null,
        bonusRoleId: bonusRole?.id || null,
        minAccountDays,
        minServerDays,
        bannerImageUrl: banner?.url || null,
        thumbImageUrl: thumb?.url || null,
        pingRoleId: pingRole?.id || data.config.defaultPingRoleId || null,
        remindersSent: { h24: false, h1: false, m10: false },
      };

      const msg = await outChannel
        .send({
          content: g.pingRoleId ? `<@&${g.pingRoleId}>` : undefined,
          embeds: [giveawayEmbed(g)],
          components: giveawayButtons(g, false),
        })
        .catch(() => null);

      if (!msg) {
        await interaction.reply({ content: "❌ Could not post giveaway message.", ephemeral: true }).catch(() => {});
        return true;
      }

      g.messageId = msg.id;
      data.giveaways[g.id] = g;
      saveJson(DATA_FILE, data);

      await postLog(logEmbed("🎁 Giveaway Created", `ID: \`${g.id}\`\nPrize: ${g.prize}\nBy: <@${interaction.user.id}>\nChannel: <#${g.channelId}>`));

      await interaction
        .reply({ content: `✅ Giveaway created in <#${g.channelId}>. ID: \`${g.id}\` (ends <t:${g.endsAtUnix}:R>).`, ephemeral: true })
        .catch(() => {});
      return true;
    }

    if (name === "giveaway-status") {
      const all = Object.values(data.giveaways);
      if (!all.length) {
        await interaction.reply({ content: "`No giveaways found.`", ephemeral: true }).catch(() => {});
        return true;
      }
      const lines = all
        .sort((a, b) => b.createdAtUnix - a.createdAtUnix)
        .slice(0, 20)
        .map(
          (g) =>
            `• \`${g.id}\` — ${g.prize} — ${g.endedAtUnix ? "ended" : "active"} — entries: \`${g.entrantIds.length}\` — channel: <#${g.channelId}>`
        );
      await interaction.reply({ content: lines.join("\n"), ephemeral: true }).catch(() => {});
      return true;
    }

    if (name === "giveaway-end") {
      const id = clean(interaction.options.getString("giveaway_id", true), 20);
      const g = data.giveaways[id];
      if (!g) {
        await interaction.reply({ content: "❌ Giveaway ID not found.", ephemeral: true }).catch(() => {});
        return true;
      }
      await endGiveaway(g, `Manually ended by ${interaction.user.tag}`);
      await interaction.reply({ content: `✅ Giveaway \`${id}\` ended.`, ephemeral: true }).catch(() => {});
      return true;
    }

    if (name === "giveaway-reroll") {
      const id = clean(interaction.options.getString("giveaway_id", true), 20);
      const g = data.giveaways[id];
      if (!g) {
        await interaction.reply({ content: "❌ Giveaway ID not found.", ephemeral: true }).catch(() => {});
        return true;
      }
      if (!g.endedAtUnix) {
        await interaction.reply({ content: "❌ Giveaway is still active. End it first.", ephemeral: true }).catch(() => {});
        return true;
      }

      const count = interaction.options.getInteger("winners", false) || g.winnerCount;
      const weighted = [];
      for (const uid of g.entrantIds) {
        weighted.push(uid);
        if (g.bonusRoleId && g.bonusEntrantIds.includes(uid)) weighted.push(uid);
      }
      g.winnerIds = chooseWinners([...new Set(weighted)], count);
      data.giveaways[g.id] = g;
      saveJson(DATA_FILE, data);

      const ch = await getTextChannel(client, g.channelId);
      if (ch) {
        await ch
          .send({
            content: `🔁 **Giveaway reroll** — ${g.prize}`,
            embeds: [
              logEmbed(
                `🎉 ${BRAND} — REROLL COMPLETE`,
                `Giveaway: \`${g.id}\`\nNew winners: ${g.winnerIds.map((x) => `<@${x}>`).join(", ") || "none"}`
              ),
            ],
          })
          .catch(() => {});
      }

      await postLog(logEmbed("🔁 Giveaway Rerolled", `ID: \`${g.id}\`\nBy: <@${interaction.user.id}>\nWinners: ${g.winnerIds.length}`));
      await interaction.reply({ content: `✅ Rerolled giveaway \`${id}\`.`, ephemeral: true }).catch(() => {});
      return true;
    }

    return false;
  }

  async function tick() {
    const all = Object.values(data.giveaways).filter((g) => !g.endedAtUnix);
    for (const g of all) {
      const diff = g.endsAtUnix - nowUnix();
      if (diff <= 0) {
        await endGiveaway(g, "Auto-complete");
        continue;
      }

      if (!data.config.remindersEnabled) continue;
      const ch = await getTextChannel(client, g.channelId);
      if (!ch) continue;

      const maybeSend = async (key, title, windowMax, windowMin) => {
        if (g.remindersSent[key]) return;
        if (!(diff <= windowMax && diff > windowMin)) return;
        g.remindersSent[key] = true;
        data.giveaways[g.id] = g;
        saveJson(DATA_FILE, data);
        await ch
          .send({
            content: g.pingRoleId ? `<@&${g.pingRoleId}>` : undefined,
            embeds: [
              logEmbed(
                `${BRAND} — ${title}`,
                `**Giveaway:** ${g.prize}\n**Ends:** <t:${g.endsAtUnix}:F> (<t:${g.endsAtUnix}:R>)\n**Entries:** \`${g.entrantIds.length}\``
              ),
            ],
          })
          .catch(() => {});
      };

      await maybeSend("h24", "24 HOURS REMAINING", 24 * 3600, 23 * 3600);
      await maybeSend("h1", "1 HOUR REMAINING", 3600, 50 * 60);
      await maybeSend("m10", "10 MINUTES REMAINING", 10 * 60, 8 * 60);
    }

    await refreshPanel();
  }

  let intervalHandle = null;
  function onReady() {
    if (!intervalHandle) intervalHandle = setInterval(() => tick().catch(() => {}), 60 * 1000);
    tick().catch(() => {});
  }

  return { name: "giveaways", commands, handleInteraction, onReady };
}

module.exports = { createGiveawaySystem };
