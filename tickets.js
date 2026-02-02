"use strict";

const fs = require("fs");
const path = require("path");
const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
  ChannelType,
} = require("discord.js");

/* -------------------- helpers -------------------- */

function safeId(x) {
  return (x || "").toString().trim();
}

function safeSnowflake(x) {
  const id = safeId(x);
  return /^\d+$/.test(id) ? id : "";
}

function envBool(v, def = false) {
  if (v == null) return def;
  return String(v).toLowerCase() === "true";
}

function envInt(v, def = 0) {
  const n = parseInt(String(v || ""), 10);
  return Number.isFinite(n) ? n : def;
}

function nowMs() {
  return Date.now();
}

function nowIso() {
  return new Date().toISOString();
}

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
    console.error("tickets saveJson error:", e?.message || e);
  }
}

function shortUserName(member) {
  const u = member?.user?.username || "user";
  return u.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12);
}

function escHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function makeTranscriptHtml(channel, messages) {
  const lines = messages
    .slice()
    .reverse()
    .map((m) => {
      const ts = m.createdAt ? m.createdAt.toISOString() : "";
      const author = `${m.author?.tag || m.author?.username || "Unknown"} (${m.author?.id || "?"})`;
      const content = escHtml(m.content || "");
      const atts =
        (m.attachments?.size ? Array.from(m.attachments.values()).map((a) => a.url).join(" ") : "") || "";
      return `<div class="msg"><div class="meta">${escHtml(ts)} — <b>${escHtml(
        author
      )}</b></div><div class="body">${content || ""}${atts ? `<div class="att">${escHtml(atts)}</div>` : ""}</div></div>`;
    })
    .join("\n");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<title>Ticket Transcript</title>
<style>
body{font-family:system-ui,Segoe UI,Roboto,Arial;margin:24px;background:#0b0b12;color:#eaeaf2}
h1{margin:0 0 10px 0;font-size:18px}
.small{opacity:.7;margin-bottom:16px}
.msg{border:1px solid #23233a;border-radius:10px;padding:10px;margin:10px 0;background:#111126}
.meta{font-size:12px;opacity:.8;margin-bottom:6px}
.body{white-space:pre-wrap;line-height:1.35}
.att{margin-top:6px;font-size:12px;opacity:.75}
</style>
</head>
<body>
<h1>Ticket Transcript — #${escHtml(channel?.name || "unknown")}</h1>
<div class="small">Exported: ${escHtml(new Date().toISOString())}</div>
${lines || "<div class='small'>No messages found.</div>"}
</body>
</html>`;
}

/* -------------------- UI builders -------------------- */

function buildPanelEmbed(cfg) {
  return new EmbedBuilder()
    .setColor(0xb100ff)
    .setTitle(cfg.panelTitle || "Support Tickets")
    .setDescription(cfg.panelDesc || "Pick a category below and we’ll open a private ticket for you.")
    .setFooter({ text: cfg.brandFooter || "Support" });
}

function buildPanelRow() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("t_open_select")
      .setPlaceholder("Open a ticket…")
      .addOptions(
        { label: "General", value: "general", description: "General support & questions" },
        { label: "Shop Issues", value: "shop", description: "Problems with shop / purchases / items" },
        { label: "Report a Player", value: "report_player", description: "Cheating, harassment, rule breaks" },
        { label: "Report a Problem / Exploit", value: "problem", description: "Bugs, exploits, broken stuff" }
      )
  );
}

function buildTicketEmbed(cfg, meta) {
  const claimLine = meta.claimedBy ? `👑 **Claimed by:** <@${meta.claimedBy}>` : "👑 **Claimed by:** _Unclaimed_";
  const seenLine = meta.staffSeen ? "✅ **Staff seen:** Yes" : "❌ **Staff seen:** Not yet";

  return new EmbedBuilder()
    .setColor(0x00e5ff)
    .setTitle(`🎟️ Ticket — ${meta.categoryLabel}`)
    .setDescription(
      [
        `**Opened by:** <@${meta.openerId}>`,
        `**Category:** ${meta.categoryLabel}`,
        claimLine,
        seenLine,
        "",
        "Explain your issue clearly. Attach screenshots/video if possible.",
        "",
        `⏱️ **Auto-close:** ${cfg.autoCloseHours}h inactivity`,
      ].join("\n")
    )
    .setFooter({ text: cfg.brandFooter || "Support" });
}

function buildControlsRow(meta) {
  const claimLabel = meta.claimedBy ? "Unclaim" : "Claim";
  const claimStyle = meta.claimedBy ? ButtonStyle.Secondary : ButtonStyle.Success;

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("t_close").setLabel("Close").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("t_transcript").setLabel("Transcript").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("t_seen").setLabel("Staff Seen").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("t_escalate").setLabel("Silent Escalation").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("t_claim").setLabel(claimLabel).setStyle(claimStyle)
  );
}

function buildToolsRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("t_add_user").setLabel("Add User").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("t_remove_user").setLabel("Remove User").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("t_rename").setLabel("Rename").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("t_report_form").setLabel("Report Form").setStyle(ButtonStyle.Primary)
  );
}

function categoryLabelFromValue(v) {
  if (v === "general") return "General";
  if (v === "shop") return "Shop Issues";
  if (v === "report_player") return "Report a Player";
  if (v === "problem") return "Report a Problem / Exploit";
  return "General";
}
function initTicketSystem(client, commandsDef /* extra args ignored */) {
  const DATA_DIR = path.join(__dirname, "data");
  const TICKETS_FILE = path.join(DATA_DIR, "tickets.json");

  const cfg = {
    categoryId: safeSnowflake(process.env.TICKET_CATEGORY_ID),
    staffRoleId: safeSnowflake(process.env.TICKET_STAFF_ROLE_ID),
    adminRoleId: safeSnowflake(process.env.TICKET_ADMIN_ROLE_ID),
    logChannelId: safeSnowflake(process.env.TICKET_LOG_CHANNEL_ID),
    transcriptsChannelId: safeSnowflake(process.env.TICKET_TRANSCRIPTS_CHANNEL_ID),
    escalateRoleId: safeSnowflake(process.env.TICKET_ESCALATE_ROLE_ID),

    panelTitle: process.env.TICKET_PANEL_TITLE || "Support Tickets",
    panelDesc: process.env.TICKET_PANEL_DESC || "Pick a category below and we’ll open a private ticket for you.",
    brandFooter: process.env.TICKET_BRAND_FOOTER || "Support",

    prefix: (process.env.TICKET_CHANNEL_PREFIX || "ticket").toLowerCase(),

    autoCloseHours: Math.max(1, envInt(process.env.TICKET_AUTO_CLOSE_HOURS, 24) || 24),
    warnMinutes: Math.max(1, envInt(process.env.TICKET_AUTO_CLOSE_WARN_MINUTES, 60) || 60),
    dmUserOnClose: envBool(process.env.TICKET_DM_USER_ON_CLOSE, true),
  };

  const db = loadJsonSafe(TICKETS_FILE, { tickets: {} }); // channelId -> meta

  function save() {
    saveJson(TICKETS_FILE, db);
  }

  function hasStaffPerms(member) {
    if (!member) return false;
    if (member.permissions?.has(PermissionFlagsBits.Administrator)) return true;
    if (cfg.adminRoleId && member.roles?.cache?.has(cfg.adminRoleId)) return true;
    if (cfg.staffRoleId && member.roles?.cache?.has(cfg.staffRoleId)) return true;
    return false;
  }

  function metaFor(channelId) {
    return db.tickets[channelId] || null;
  }

  function findOpenTicketForUser(guildId, userId) {
    return Object.values(db.tickets).find((t) => t.guildId === guildId && t.openerId === userId && !t.closedAt) || null;
  }

  async function fetchTextChannel(guild, channelId) {
    if (!channelId) return null;
    const ch = await guild.channels.fetch(channelId).catch(() => null);
    if (!ch || !("send" in ch)) return null;
    return ch;
  }

  async function logEvent(guild, content, embed = null) {
    const ch = await fetchTextChannel(guild, cfg.logChannelId);
    if (!ch) return;
    await ch.send(embed ? { content, embeds: [embed] } : { content }).catch(() => {});
  }

  async function postTranscript(guild, filename, htmlBuffer) {
    const targetId = cfg.transcriptsChannelId || cfg.logChannelId;
    const ch = await fetchTextChannel(guild, targetId);
    if (!ch) return null;

    const msg = await ch
      .send({
        content: `📎 Transcript uploaded: **${filename}**`,
        files: [{ attachment: htmlBuffer, name: filename }],
      })
      .catch(() => null);

    return msg;
  }

  async function updateTicketMessage(channel, meta) {
    try {
      const msgs = await channel.messages.fetch({ limit: 15 });
      const botMsg = Array.from(msgs.values()).find(
        (m) => m.author?.id === client.user.id && m.components?.length
      );
      if (!botMsg) return;

      const embed = buildTicketEmbed(cfg, meta);
      const row1 = buildControlsRow(meta);
      const row2 = buildToolsRow();

      // Only show Report Form button row if report_player category, otherwise keep tools row without report
      if (meta.categoryValue !== "report_player") {
        row2.components = row2.components.filter((b) => b.data.custom_id !== "t_report_form");
      }

      await botMsg.edit({ embeds: [embed], components: [row1, row2] }).catch(() => {});
    } catch {}
  }

  async function createTicketChannel(guild, openerId, categoryValue) {
    if (!cfg.categoryId) throw new Error("TICKET_CATEGORY_ID missing");
    if (!cfg.staffRoleId && !cfg.adminRoleId) throw new Error("TICKET_STAFF_ROLE_ID (or TICKET_ADMIN_ROLE_ID) missing");

    const category = await guild.channels.fetch(cfg.categoryId).catch(() => null);
    if (!category || category.type !== ChannelType.GuildCategory) {
      throw new Error("TICKET_CATEGORY_ID is not a valid category");
    }

    const label = categoryLabelFromValue(categoryValue);
    const openerMember = await guild.members.fetch(openerId).catch(() => null);
    const uname = shortUserName(openerMember);
    const short = openerId.slice(-4);
    const name = `${cfg.prefix}-${uname}-${short}`.slice(0, 90);

    const overwrites = [
      { id: guild.roles.everyone.id, deny: ["ViewChannel"] },
      { id: openerId, allow: ["ViewChannel", "SendMessages", "ReadMessageHistory", "AttachFiles", "EmbedLinks"] },
    ];
    if (cfg.staffRoleId) overwrites.push({ id: cfg.staffRoleId, allow: ["ViewChannel", "SendMessages", "ReadMessageHistory"] });
    if (cfg.adminRoleId) overwrites.push({ id: cfg.adminRoleId, allow: ["ViewChannel", "SendMessages", "ReadMessageHistory"] });

    const ch = await guild.channels.create({
      name,
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: overwrites,
      topic: `Ticket • ${label} • opener=${openerId} • created=${nowIso()}`,
    });

    db.tickets[ch.id] = {
      channelId: ch.id,
      guildId: guild.id,
      openerId,
      categoryValue,
      categoryLabel: label,

      staffSeen: false,
      claimedBy: null,

      createdAt: nowMs(),
      lastActivityAt: nowMs(),
      warnedAt: null,

      closedAt: null,
      closedBy: null,
      closeReason: null,

      escalations: 0,
      transcriptMsgId: null,
    };
    save();

    const meta = db.tickets[ch.id];

    const embed = buildTicketEmbed(cfg, meta);
    const row1 = buildControlsRow(meta);
    const row2 = buildToolsRow();
    if (meta.categoryValue !== "report_player") {
      row2.components = row2.components.filter((b) => b.data.custom_id !== "t_report_form");
    }

    await ch.send({ content: `✅ Ticket opened for <@${openerId}>`, embeds: [embed], components: [row1, row2] }).catch(() => {});
    await ch.send({ content: "📝 Please describe your issue. Attach screenshots/video if possible." }).catch(() => {});

    if (categoryValue === "report_player") {
      await ch.send({
        content:
          "🚨 **Report a Player**\nPlease click **Report Form** (button above) and fill it out.\nIf you have evidence, attach it here too.",
      }).catch(() => {});
    }

    await logEvent(
      guild,
      `🎟️ **Ticket opened** • ${label} • <@${openerId}> • <#${ch.id}>`,
      new EmbedBuilder()
        .setColor(0x00e5ff)
        .setTitle("Ticket Opened")
        .addFields(
          { name: "Category", value: label, inline: true },
          { name: "User", value: `<@${openerId}> (${openerId})`, inline: true },
          { name: "Channel", value: `<#${ch.id}>`, inline: true }
        )
        .setFooter({ text: cfg.brandFooter || "Support" })
    );

    return ch;
  }

  async function doTranscript(interaction, meta) {
    const channel = interaction.channel;
    const guild = interaction.guild;
    if (!channel || !guild) return null;

    const msgs = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    const arr = msgs ? Array.from(msgs.values()) : [];

    const html = makeTranscriptHtml(channel, arr);
    const filename = `ticket-${channel.id}-${new Date().toISOString().replace(/[:.]/g, "-")}.html`;
    const buf = Buffer.from(html, "utf8");

    const sent = await postTranscript(guild, filename, buf);
    if (sent) {
      meta.transcriptMsgId = sent.id;
      save();
    }
    return sent;
  }

  async function closeTicket(channel, guild, meta, closedById, reason, systemAuto = false) {
    meta.closedAt = nowMs();
    meta.closedBy = closedById || "SYSTEM";
    meta.closeReason = reason || "No reason provided";
    save();

    // transcript best effort
    try {
      const msgs = await channel.messages.fetch({ limit: 100 }).catch(() => null);
      const arr = msgs ? Array.from(msgs.values()) : [];
      const html = makeTranscriptHtml(channel, arr);
      const filename = `ticket-${channel.id}-${new Date().toISOString().replace(/[:.]/g, "-")}.html`;
      const buf = Buffer.from(html, "utf8");
      const sent = await postTranscript(guild, filename, buf);
      if (sent) {
        meta.transcriptMsgId = sent.id;
        save();
      }
    } catch {}

    await logEvent(
      guild,
      `🔒 **Ticket closed** • <#${channel.id}> • by ${closedById ? `<@${closedById}>` : "SYSTEM"} • reason: ${meta.closeReason}`
    );

    // DM user (optional)
    if (cfg.dmUserOnClose && meta.openerId) {
      try {
        const u = await client.users.fetch(meta.openerId);
        await u.send(
          `🔒 Your ticket in **${guild.name}** was closed.\n**Reason:** ${meta.closeReason}\n${
            systemAuto ? "(Auto-closed due to inactivity)" : ""
          }`
        );
      } catch {}
    }

    // lock opener from sending
    try {
      await channel.permissionOverwrites.edit(meta.openerId, { SendMessages: false });
    } catch {}

    // rename
    try {
      if (!channel.name.startsWith("closed-")) {
        await channel.setName(`closed-${channel.name}`.slice(0, 100));
      }
    } catch {}

    const e = new EmbedBuilder()
      .setColor(0x050012)
      .setTitle("🔒 Ticket Closed")
      .setDescription(
        `Closed by ${closedById ? `<@${closedById}>` : "SYSTEM"}\n**Reason:** ${meta.closeReason}${
          systemAuto ? "\n\n⏱️ Auto-closed due to inactivity." : ""
        }`
      )
      .setFooter({ text: cfg.brandFooter || "Support" });

    await channel.send({ embeds: [e] }).catch(() => {});
  }
  /* -------------------- commands -------------------- */

  const commands = [
    new SlashCommandBuilder()
      .setName("ticketpanel")
      .setDescription("Post the ticket panel (staff/admin).")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  ];

  // If your bot passes a commands array, we can push our command into it.
  if (Array.isArray(commandsDef)) {
    for (const c of commands) commandsDef.push(c);
  }

  /* -------------------- inactivity auto close -------------------- */

  async function inactivitySweep() {
    try {
      const autoCloseMs = cfg.autoCloseHours * 60 * 60 * 1000;
      const warnMs = cfg.warnMinutes * 60 * 1000;

      for (const meta of Object.values(db.tickets)) {
        if (!meta || meta.closedAt) continue;

        const guild = await client.guilds.fetch(meta.guildId).catch(() => null);
        if (!guild) continue;

        const ch = await guild.channels.fetch(meta.channelId).catch(() => null);
        if (!ch || !("send" in ch)) continue;

        const idleMs = nowMs() - (meta.lastActivityAt || meta.createdAt || nowMs());
        const timeLeft = autoCloseMs - idleMs;

        // warn once at ~1h left
        if (timeLeft <= warnMs && timeLeft > 0 && !meta.warnedAt) {
          meta.warnedAt = nowMs();
          save();
          await ch
            .send(
              `⏱️ **Inactivity warning:** This ticket will auto-close in about **${cfg.warnMinutes} minutes** if nobody replies.`
            )
            .catch(() => {});
          continue;
        }

        // close when expired
        if (timeLeft <= 0) {
          await closeTicket(ch, guild, meta, null, "Auto-closed after 24 hours of inactivity.", true).catch(() => {});
        }
      }
    } catch (e) {
      console.error("tickets inactivitySweep error:", e?.message || e);
    }
  }

  if (client && !client.__ticketsSweepBound) {
    client.__ticketsSweepBound = true;
    setInterval(inactivitySweep, 5 * 60 * 1000); // every 5 mins
  }

  /* -------------------- interaction handler -------------------- */

  async function handleInteraction(interaction) {
    try {
      // /ticketpanel
      if (interaction.isChatInputCommand() && interaction.commandName === "ticketpanel") {
        if (!hasStaffPerms(interaction.member)) {
          return interaction.reply({ content: "❌ Staff only.", ephemeral: true });
        }
        const embed = buildPanelEmbed(cfg);
        const row = buildPanelRow();

        await interaction.reply({ content: "✅ Ticket panel posted.", ephemeral: true }).catch(() => {});
        await interaction.channel.send({ embeds: [embed], components: [row] }).catch(() => {});
        return true;
      }

      // open ticket dropdown
      if (interaction.isStringSelectMenu() && interaction.customId === "t_open_select") {
        const guild = interaction.guild;
        if (!guild) return true;

        const existing = findOpenTicketForUser(guild.id, interaction.user.id);
        if (existing) {
          return interaction.reply({ content: `❌ You already have an open ticket: <#${existing.channelId}>`, ephemeral: true });
        }

        await interaction.reply({ content: "⏳ Creating your ticket…", ephemeral: true });

        try {
          const v = interaction.values?.[0];
          const ch = await createTicketChannel(guild, interaction.user.id, v);
          await interaction.editReply({ content: `✅ Ticket created: <#${ch.id}>` }).catch(() => {});
        } catch (e) {
          await interaction.editReply({ content: `❌ Failed to create ticket: ${e?.message || e}` }).catch(() => {});
        }
        return true;
      }

      // ticket buttons
      if (interaction.isButton()) {
        const meta = metaFor(interaction.channelId);
        if (!meta) return false;

        const isStaff = hasStaffPerms(interaction.member);
        const isOpener = interaction.user.id === meta.openerId;
        const channel = interaction.channel;
        const guild = interaction.guild;

        if (!guild || !channel) return true;

        // Close -> modal
        if (interaction.customId === "t_close") {
          if (!isStaff && !isOpener) {
            return interaction.reply({ content: "❌ Only the opener or staff can close.", ephemeral: true });
          }

          const modal = new ModalBuilder().setCustomId("t_close_modal").setTitle("Close Ticket");
          const input = new TextInputBuilder()
            .setCustomId("reason")
            .setLabel("Reason for closing")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false)
            .setMaxLength(400);

          modal.addComponents(new ActionRowBuilder().addComponents(input));
          await interaction.showModal(modal).catch(() => {});
          return true;
        }

        // Transcript
        if (interaction.customId === "t_transcript") {
          if (!isStaff) return interaction.reply({ content: "❌ Staff only.", ephemeral: true });
          await interaction.reply({ content: "⏳ Generating transcript…", ephemeral: true });
          const sent = await doTranscript(interaction, meta).catch(() => null);
          if (sent) return interaction.editReply({ content: "✅ Transcript uploaded to logs/transcripts channel." }).catch(() => {});
          return interaction.editReply({ content: "⚠️ Transcript failed (check bot perms)." }).catch(() => {});
        }

        // Staff seen toggle
        if (interaction.customId === "t_seen") {
          if (!isStaff) return interaction.reply({ content: "❌ Staff only.", ephemeral: true });
          meta.staffSeen = !meta.staffSeen;
          meta.lastActivityAt = nowMs();
          save();
          await interaction.reply({ content: `✅ Staff seen: ${meta.staffSeen ? "ON" : "OFF"}`, ephemeral: true }).catch(() => {});
          await updateTicketMessage(channel, meta);
          return true;
        }

        // Silent escalation
        if (interaction.customId === "t_escalate") {
          if (!isStaff) return interaction.reply({ content: "❌ Staff only.", ephemeral: true });
          meta.escalations = (meta.escalations || 0) + 1;
          meta.lastActivityAt = nowMs();
          save();

          const ping = cfg.escalateRoleId ? `<@&${cfg.escalateRoleId}> ` : "";
          await logEvent(
            guild,
            `🚨 ${ping}**Silent escalation** • <#${interaction.channelId}> • by <@${interaction.user.id}> • count: ${meta.escalations}`
          );

          return interaction.reply({ content: "✅ Escalation logged (silent).", ephemeral: true });
        }

        // Claim/Unclaim
        if (interaction.customId === "t_claim") {
          if (!isStaff) return interaction.reply({ content: "❌ Staff only.", ephemeral: true });

          if (!meta.claimedBy) meta.claimedBy = interaction.user.id;
          else if (meta.claimedBy === interaction.user.id) meta.claimedBy = null;
          else return interaction.reply({ content: `❌ Already claimed by <@${meta.claimedBy}>`, ephemeral: true });

          meta.lastActivityAt = nowMs();
          save();

          await interaction.reply({ content: `✅ ${meta.claimedBy ? "Claimed" : "Unclaimed"} ticket.`, ephemeral: true }).catch(() => {});
          await updateTicketMessage(channel, meta);
          return true;
        }

        // Add user modal
        if (interaction.customId === "t_add_user") {
          if (!isStaff) return interaction.reply({ content: "❌ Staff only.", ephemeral: true });

          const modal = new ModalBuilder().setCustomId("t_add_user_modal").setTitle("Add User");
          const input = new TextInputBuilder()
            .setCustomId("userid")
            .setLabel("User ID to add")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(30);

          modal.addComponents(new ActionRowBuilder().addComponents(input));
          await interaction.showModal(modal).catch(() => {});
          return true;
        }

        // Remove user modal
        if (interaction.customId === "t_remove_user") {
          if (!isStaff) return interaction.reply({ content: "❌ Staff only.", ephemeral: true });

          const modal = new ModalBuilder().setCustomId("t_remove_user_modal").setTitle("Remove User");
          const input = new TextInputBuilder()
            .setCustomId("userid")
            .setLabel("User ID to remove")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(30);

          modal.addComponents(new ActionRowBuilder().addComponents(input));
          await interaction.showModal(modal).catch(() => {});
          return true;
        }

        // Rename modal
        if (interaction.customId === "t_rename") {
          if (!isStaff) return interaction.reply({ content: "❌ Staff only.", ephemeral: true });

          const modal = new ModalBuilder().setCustomId("t_rename_modal").setTitle("Rename Ticket");
          const input = new TextInputBuilder()
            .setCustomId("name")
            .setLabel("New channel name (no spaces)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(80);

          modal.addComponents(new ActionRowBuilder().addComponents(input));
          await interaction.showModal(modal).catch(() => {});
          return true;
        }

        // Report form modal
        if (interaction.customId === "t_report_form") {
          if (meta.categoryValue !== "report_player") {
            return interaction.reply({ content: "⚠️ Report form only applies to Report a Player tickets.", ephemeral: true });
          }

          const modal = new ModalBuilder().setCustomId("t_report_form_modal").setTitle("Report a Player");

          const player = new TextInputBuilder()
            .setCustomId("player")
            .setLabel("Player name / ID")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(80);

          const reason = new TextInputBuilder()
            .setCustomId("reason")
            .setLabel("What happened? (short but clear)")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(800);

          const evidence = new TextInputBuilder()
            .setCustomId("evidence")
            .setLabel("Evidence links (video/screenshots) or 'none'")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false)
            .setMaxLength(800);

          modal.addComponents(
            new ActionRowBuilder().addComponents(player),
            new ActionRowBuilder().addComponents(reason),
            new ActionRowBuilder().addComponents(evidence)
          );

          await interaction.showModal(modal).catch(() => {});
          return true;
        }
      }

      // close modal submit
      if (interaction.isModalSubmit() && interaction.customId === "t_close_modal") {
        const meta = metaFor(interaction.channelId);
        if (!meta) return false;

        const isStaff = hasStaffPerms(interaction.member);
        const isOpener = interaction.user.id === meta.openerId;
        if (!isStaff && !isOpener) {
          return interaction.reply({ content: "❌ Only the opener or staff can close.", ephemeral: true });
        }

        const reason = interaction.fields.getTextInputValue("reason") || "No reason provided";
        await interaction.reply({ content: "🔒 Closing ticket…", ephemeral: true }).catch(() => {});
        await closeTicket(interaction.channel, interaction.guild, meta, interaction.user.id, reason, false).catch(() => {});
        return true;
      }

      // add user modal submit
      if (interaction.isModalSubmit() && interaction.customId === "t_add_user_modal") {
        const meta = metaFor(interaction.channelId);
        if (!meta) return false;
        if (!hasStaffPerms(interaction.member)) return interaction.reply({ content: "❌ Staff only.", ephemeral: true });

        const uid = (interaction.fields.getTextInputValue("userid") || "").trim();
        await interaction.reply({ content: "⏳ Adding user…", ephemeral: true });

        try {
          await interaction.channel.permissionOverwrites.edit(uid, {
            ViewChannel: true,
            SendMessages: true,
            ReadMessageHistory: true,
          });
          meta.lastActivityAt = nowMs();
          save();
          await interaction.editReply({ content: `✅ Added <@${uid}> to this ticket.` }).catch(() => {});
        } catch {
          await interaction.editReply({ content: "❌ Failed to add user (check ID & permissions)." }).catch(() => {});
        }
        return true;
      }

      // remove user modal submit
      if (interaction.isModalSubmit() && interaction.customId === "t_remove_user_modal") {
        const meta = metaFor(interaction.channelId);
        if (!meta) return false;
        if (!hasStaffPerms(interaction.member)) return interaction.reply({ content: "❌ Staff only.", ephemeral: true });

        const uid = (interaction.fields.getTextInputValue("userid") || "").trim();
        await interaction.reply({ content: "⏳ Removing user…", ephemeral: true });

        try {
          await interaction.channel.permissionOverwrites.delete(uid);
          meta.lastActivityAt = nowMs();
          save();
          await interaction.editReply({ content: `✅ Removed <@${uid}> from this ticket.` }).catch(() => {});
        } catch {
          await interaction.editReply({ content: "❌ Failed to remove user (check ID & permissions)." }).catch(() => {});
        }
        return true;
      }

      // rename modal submit
      if (interaction.isModalSubmit() && interaction.customId === "t_rename_modal") {
        const meta = metaFor(interaction.channelId);
        if (!meta) return false;
        if (!hasStaffPerms(interaction.member)) return interaction.reply({ content: "❌ Staff only.", ephemeral: true });

        const name = (interaction.fields.getTextInputValue("name") || "").trim().toLowerCase();
        await interaction.reply({ content: "⏳ Renaming…", ephemeral: true });

        try {
          await interaction.channel.setName(name.slice(0, 90));
          meta.lastActivityAt = nowMs();
          save();
          await interaction.editReply({ content: `✅ Renamed channel to **${name}**` }).catch(() => {});
        } catch {
          await interaction.editReply({ content: "❌ Failed to rename (check permissions)." }).catch(() => {});
        }
        return true;
      }

      // report form submit
      if (interaction.isModalSubmit() && interaction.customId === "t_report_form_modal") {
        const meta = metaFor(interaction.channelId);
        if (!meta) return false;

        const player = interaction.fields.getTextInputValue("player") || "Unknown";
        const reason = interaction.fields.getTextInputValue("reason") || "—";
        const evidence = interaction.fields.getTextInputValue("evidence") || "None";

        meta.lastActivityAt = nowMs();
        save();

        const e = new EmbedBuilder()
          .setColor(0xff2d55)
          .setTitle("🚨 Player Report Submitted")
          .addFields(
            { name: "Reported Player", value: player.slice(0, 1024), inline: false },
            { name: "What happened", value: reason.slice(0, 1024), inline: false },
            { name: "Evidence", value: evidence.slice(0, 1024), inline: false },
            { name: "Reporter", value: `<@${interaction.user.id}> (${interaction.user.id})`, inline: false }
          )
          .setFooter({ text: cfg.brandFooter || "Support" });

        await interaction.reply({ content: "✅ Report form posted into the ticket.", ephemeral: true }).catch(() => {});
        await interaction.channel.send({ embeds: [e] }).catch(() => {});

        // also log it
        if (interaction.guild) {
          await logEvent(interaction.guild, `🚨 **Player report submitted** in <#${interaction.channelId}> by <@${interaction.user.id}>`);
        }
        return true;
      }
    } catch (e) {
      console.error("tickets handleInteraction error:", e?.message || e);
      try {
        if (interaction?.reply && !interaction.replied) {
          await interaction.reply({ content: "❌ Ticket system error (check logs).", ephemeral: true });
        }
      } catch {}
      return true;
    }

    return false;
  }

  /* -------------------- message activity tracking -------------------- */

  if (client && !client.__ticketsMsgBound) {
    client.__ticketsMsgBound = true;

    client.on("messageCreate", async (msg) => {
      try {
        if (!msg.guild || msg.author?.bot) return;
        const meta = metaFor(msg.channelId);
        if (!meta || meta.closedAt) return;

        meta.lastActivityAt = nowMs();
        meta.warnedAt = null; // reset warning if someone talks again
        save();
      } catch {}
    });
  }

  return { commands, handleInteraction };
}

module.exports = { initTicketSystem };
