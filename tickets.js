// spirals3x/tickets.js
"use strict";

const fs = require("fs");
const path = require("path");
const {
  EmbedBuilder,
  PermissionsBitField,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  AttachmentBuilder,
} = require("discord.js");

/**
 * Ticket system:
 * - Panel buttons create private channels under a parent CATEGORY
 * - Staff buttons manage state
 * - Logs + transcript + attachments vault
 * - SLA silent escalation (pings in LOG channel only)
 * - Staff "seen" indicator triggered by first staff message OR claim button
 */

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
  const bak = `${file}.bak`;
  try {
    if (fs.existsSync(file)) {
      try {
        fs.copyFileSync(file, bak);
      } catch {}
    }
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {}
    console.error("saveJson error:", e?.message || e);
  }
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function isStaff(member, supportRoleIds = []) {
  if (!member) return false;
  if (member.permissions?.has(PermissionsBitField.Flags.Administrator)) return true;
  return supportRoleIds.some((rid) => member.roles?.cache?.has(rid));
}

function mentionRoleList(roleIds) {
  const ids = (roleIds || []).filter(Boolean);
  if (!ids.length) return "";
  return ids.map((id) => `<@&${id}>`).join(" ");
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function cleanChannelName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function buildPanelEmbed(brand) {
  return new EmbedBuilder()
    .setColor(brand.COLOR_ACCENT)
    .setTitle(`🌀 ${brand.BRAND} — Support`)
    .setDescription(
      `Need help? Open a ticket using the buttons below.\n\n` +
        `🛒 **Shop & Purchases** — missing items, payment, delivery\n` +
        `🚨 **Report a Player** — rule-breaking, cheating, harassment\n` +
        `🧩 **Technical / Bot Issue** — commands not working, errors\n` +
        `💬 **General Support** — questions, unsure where it fits\n` +
        `⚠️ **Staff / Server Issue** — staff issues, permissions, appeals\n\n` +
        `⏱️ Response is tracked automatically. Abuse/cooldowns are enforced.`
    )
    .setFooter({ text: brand.FOOTER });
}

function buildPanelRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("ticket:create:shop").setLabel("Shop & Purchases").setStyle(ButtonStyle.Primary).setEmoji("🛒"),
    new ButtonBuilder().setCustomId("ticket:create:report").setLabel("Report a Player").setStyle(ButtonStyle.Danger).setEmoji("🚨"),
    new ButtonBuilder().setCustomId("ticket:create:tech").setLabel("Technical / Bot Issue").setStyle(ButtonStyle.Secondary).setEmoji("🧩"),
    new ButtonBuilder().setCustomId("ticket:create:general").setLabel("General Support").setStyle(ButtonStyle.Success).setEmoji("💬"),
    new ButtonBuilder().setCustomId("ticket:create:staff").setLabel("Staff / Server").setStyle(ButtonStyle.Secondary).setEmoji("⚠️")
  );
}

function buildTicketControlsRow(state) {
  // state-aware (reopen only appears when closed)
  const row = new ActionRowBuilder();

  row.addComponents(
    new ButtonBuilder().setCustomId("ticket:claim").setLabel("Claim").setStyle(ButtonStyle.Primary).setEmoji("🧷"),
    new ButtonBuilder().setCustomId("ticket:adduser").setLabel("Add user").setStyle(ButtonStyle.Secondary).setEmoji("➕"),
    new ButtonBuilder().setCustomId("ticket:note").setLabel("Staff note").setStyle(ButtonStyle.Secondary).setEmoji("📝"),
    new ButtonBuilder().setCustomId("ticket:incident").setLabel("Incident").setStyle(ButtonStyle.Secondary).setEmoji("⚠️")
  );

  const row2 = new ActionRowBuilder();
  row2.addComponents(
    new ButtonBuilder()
      .setCustomId(state === "CLOSED" ? "ticket:reopen" : "ticket:close")
      .setLabel(state === "CLOSED" ? "Reopen" : "Close")
      .setStyle(state === "CLOSED" ? ButtonStyle.Success : ButtonStyle.Danger)
      .setEmoji(state === "CLOSED" ? "🔓" : "🔒")
  );

  return [row, row2];
}

function buildTicketIntroEmbed(brand, ticket) {
  const catName = {
    shop: "Shop & Purchases",
    report: "Report a Player",
    tech: "Technical / Bot Issue",
    general: "General Support",
    staff: "Staff / Server Issue",
  }[ticket.categoryKey] || "Support";

  return new EmbedBuilder()
    .setColor(brand.COLOR_PRIMARY)
    .setTitle(`🎫 Ticket • ${catName}`)
    .setDescription(
      `**Owner:** <@${ticket.userId}>\n` +
        `**Status:** **${ticket.state}**\n` +
        `**Created:** <t:${ticket.createdAt}:F>\n\n` +
        `Please describe your issue clearly.\n` +
        `Staff will respond as soon as possible.`
    )
    .setFooter({ text: brand.FOOTER });
}

function buildLogEmbed(brand, title, fields = []) {
  const e = new EmbedBuilder().setColor(brand.COLOR_NEUTRAL).setTitle(title).setFooter({ text: brand.FOOTER });
  if (fields.length) e.addFields(fields);
  return e;
}

async function fetchTextChannel(guild, id) {
  if (!id) return null;
  return guild.channels.fetch(id).catch(() => null);
}

async function safeSend(channel, payload) {
  if (!channel || !("send" in channel)) return null;
  return channel.send(payload).catch(() => null);
}

async function safeEdit(message, payload) {
  if (!message) return null;
  return message.edit(payload).catch(() => null);
}

async function createTranscript(channel) {
  // fetch up to 250 recent messages (paginated)
  let all = [];
  let lastId = null;

  for (let i = 0; i < 3; i++) {
    const batch = await channel.messages.fetch({ limit: 100, before: lastId || undefined }).catch(() => null);
    if (!batch || !batch.size) break;
    const arr = [...batch.values()];
    all.push(...arr);
    lastId = arr[arr.length - 1].id;
    if (batch.size < 100) break;
  }

  all = all.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  const lines = [];
  for (const m of all) {
    const ts = new Date(m.createdTimestamp).toISOString();
    const author = `${m.author?.tag || "Unknown"} (${m.author?.id || "?"})`;
    const content = (m.content || "").replace(/\r/g, "");
    const attach = m.attachments?.size ? ` [attachments: ${m.attachments.size}]` : "";
    lines.push(`[${ts}] ${author}: ${content}${attach}`);
    if (m.embeds?.length) lines.push(`  [embeds: ${m.embeds.length}]`);
  }

  const body = lines.join("\n") || "(No messages)";
  const buf = Buffer.from(body, "utf8");
  const file = new AttachmentBuilder(buf, { name: `transcript-${channel.id}.txt` });

  // collect attachment URLs
  const attachmentUrls = [];
  for (const m of all) {
    for (const a of m.attachments?.values?.() || []) {
      if (a?.url) attachmentUrls.push({ url: a.url, name: a.name || "file" });
    }
  }

  return { file, attachmentUrls, count: all.length };
}

function makeTicketId() {
  return `T${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`.toUpperCase();
}

function avg(arr) {
  if (!arr.length) return 0;
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}

function initTicketSystem({ brand, dataDir }) {
  const DATA_DIR = dataDir;
  const TICKETS_FILE = path.join(DATA_DIR, "tickets.json");
  ensureDir(DATA_DIR);

  const db = loadJsonSafe(TICKETS_FILE, {
    meta: { createdAt: Date.now() },
    tickets: {}, // ticketId -> ticket
    openByUser: {}, // userId -> [ticketId]
    metrics: {
      staff: {}, // staffId -> { claims, closes, firstResponses: [sec] }
    },
  });

  function persist() {
    saveJson(TICKETS_FILE, db);
  }

  function getConfig() {
    const supportRoleIds = (process.env.SUPPORT_ROLE_IDS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const escalationRoleIds = (process.env.ESCALATION_ROLE_IDS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    return {
      GUILD_ID: process.env.GUILD_ID,
      TICKET_PARENT_CATEGORY_ID: process.env.TICKET_PARENT_CATEGORY_ID || "",
      TICKET_PANEL_CHANNEL_ID: process.env.TICKET_PANEL_CHANNEL_ID || "",
      TICKET_LOG_CHANNEL_ID: process.env.TICKET_LOG_CHANNEL_ID || "",
      TICKET_TRANSCRIPT_CHANNEL_ID: process.env.TICKET_TRANSCRIPT_CHANNEL_ID || "",
      TICKET_ATTACHMENTS_VAULT_CHANNEL_ID: process.env.TICKET_ATTACHMENTS_VAULT_CHANNEL_ID || "",
      SUPPORT_ROLE_IDS: supportRoleIds,
      ESCALATION_ROLE_IDS: escalationRoleIds,
      SLA_MINUTES: clamp(parseInt(process.env.TICKET_SLA_MINUTES || "30", 10) || 30, 5, 720),
      COOLDOWN_MINUTES: clamp(parseInt(process.env.TICKET_COOLDOWN_MINUTES || "2", 10) || 2, 0, 120),
      MAX_OPEN_PER_USER: clamp(parseInt(process.env.TICKET_MAX_OPEN_PER_USER || "2", 10) || 2, 1, 10),
      AUTO_ARCHIVE_HOURS: clamp(parseInt(process.env.TICKET_AUTO_ARCHIVE_HOURS || "48", 10) || 48, 1, 720),
    };
  }

  function userOpenTickets(userId) {
    const ids = db.openByUser[userId] || [];
    return ids
      .map((id) => db.tickets[id])
      .filter(Boolean)
      .filter((t) => t.state !== "CLOSED");
  }

  function addOpenForUser(userId, ticketId) {
    if (!db.openByUser[userId]) db.openByUser[userId] = [];
    if (!db.openByUser[userId].includes(ticketId)) db.openByUser[userId].push(ticketId);
  }

  function removeOpenForUser(userId, ticketId) {
    const arr = db.openByUser[userId] || [];
    db.openByUser[userId] = arr.filter((x) => x !== ticketId);
  }

  function ensureStaffMetric(staffId) {
    if (!db.metrics.staff[staffId]) db.metrics.staff[staffId] = { claims: 0, closes: 0, firstResponses: [] };
    return db.metrics.staff[staffId];
  }

  async function log(guild, title, fields = []) {
    const cfg = getConfig();
    const ch = await fetchTextChannel(guild, cfg.TICKET_LOG_CHANNEL_ID);
    await safeSend(ch, { embeds: [buildLogEmbed(brand, title, fields)] });
  }

  async function escalateIfNeeded(client, ticketId) {
    const t = db.tickets[ticketId];
    if (!t || t.state === "CLOSED") return;

    // only escalate if no staff response yet
    if (t.staffFirstResponseAt) return;
    if (t.escalatedAt) return;

    const cfg = getConfig();
    const guild = await client.guilds.fetch(t.guildId).catch(() => null);
    if (!guild) return;

    const logCh = await fetchTextChannel(guild, cfg.TICKET_LOG_CHANNEL_ID);
    if (!logCh) return;

    const rolesPing = mentionRoleList(cfg.ESCALATION_ROLE_IDS.length ? cfg.ESCALATION_ROLE_IDS : cfg.SUPPORT_ROLE_IDS);

    t.escalatedAt = nowSec();
    persist();

    await safeSend(logCh, {
      content: rolesPing ? `⏱️ **Silent Escalation** — no staff response in SLA.\n${rolesPing}` : `⏱️ **Silent Escalation** — no staff response in SLA.`,
      embeds: [
        new EmbedBuilder()
          .setColor(brand.COLOR_ACCENT)
          .setTitle("⏱️ SLA Escalation")
          .setDescription(`Ticket: <#${t.channelId}>\nOwner: <@${t.userId}>\nCreated: <t:${t.createdAt}:R>`)
          .setFooter({ text: brand.FOOTER }),
      ],
      allowedMentions: { roles: (cfg.ESCALATION_ROLE_IDS.length ? cfg.ESCALATION_ROLE_IDS : cfg.SUPPORT_ROLE_IDS) },
    });
  }

  function scheduleEscalation(client, ticketId) {
    const cfg = getConfig();
    const t = db.tickets[ticketId];
    if (!t) return;

    // clear existing
    if (t._slaTimer) clearTimeout(t._slaTimer);

    const ms = cfg.SLA_MINUTES * 60 * 1000;
    const when = t.createdAt * 1000 + ms;
    const delay = Math.max(5_000, when - Date.now());

    t._slaTimer = setTimeout(() => {
      escalateIfNeeded(client, ticketId).catch(() => {});
    }, delay);
  }

  async function postPanel(interaction) {
    const cfg = getConfig();
    if (!interaction.guild) return;

    const isAdmin = interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);
    if (!isAdmin) return interaction.reply({ content: "❌ Admin only.", ephemeral: true });

    const ch = interaction.channel;
    if (!ch || !("send" in ch)) return interaction.reply({ content: "❌ Not a text channel.", ephemeral: true });

    const embed = buildPanelEmbed(brand);
    const row = buildPanelRow();

    const msg = await safeSend(ch, { embeds: [embed], components: [row] });
    if (!msg) return interaction.reply({ content: "❌ Failed to post panel.", ephemeral: true });

    await interaction.reply({
      content: `✅ Ticket panel posted here.\nTip: set \`TICKET_PANEL_CHANNEL_ID\` to \`${ch.id}\` in your .env.`,
      ephemeral: true,
    });
  }

  async function createTicket(interaction, categoryKey) {
    const cfg = getConfig();
    const guild = interaction.guild;
    if (!guild) return;

    const userId = interaction.user.id;

    // cooldown
    const open = userOpenTickets(userId);
    if (open.length >= cfg.MAX_OPEN_PER_USER) {
      return interaction.reply({
        content: `❌ You already have **${open.length}** open ticket(s). Please close one before opening another.`,
        ephemeral: true,
      });
    }

    const lastCreated = open
      .map((t) => t.createdAt)
      .sort((a, b) => b - a)[0];

    if (lastCreated) {
      const cooldown = cfg.COOLDOWN_MINUTES * 60;
      const left = lastCreated + cooldown - nowSec();
      if (left > 0) {
        return interaction.reply({ content: `⏳ Please wait <t:${nowSec() + left}:R> before opening another ticket.`, ephemeral: true });
      }
    }

    const parent = cfg.TICKET_PARENT_CATEGORY_ID ? await guild.channels.fetch(cfg.TICKET_PARENT_CATEGORY_ID).catch(() => null) : null;

    if (!parent || parent.type !== ChannelType.GuildCategory) {
      return interaction.reply({
        content:
          "❌ Ticket system not configured.\nAsk staff to set `TICKET_PARENT_CATEGORY_ID` in the VPS `.env` (a CATEGORY ID).",
        ephemeral: true,
      });
    }

    const ticketId = makeTicketId();
    const createdAt = nowSec();
    const ticket = {
      ticketId,
      guildId: guild.id,
      userId,
      categoryKey,
      state: "OPEN",
      createdAt,
      claimedBy: null,
      staffFirstResponseAt: null,
      staffSeenAt: null,
      escalatedAt: null,
      incident: false,
      staffNotes: [],
      addedUsers: [],
      rating: null,
      closedAt: null,
      closeReason: null,
      channelId: null,
    };

    const owner = await guild.members.fetch(userId).catch(() => null);

    const baseName = cleanChannelName(`${categoryKey}-${owner?.user?.username || userId}`) || `ticket-${ticketId.toLowerCase()}`;
    const channelName = `${baseName}`.slice(0, 90);

    // perms: deny @everyone, allow owner, allow support roles, allow bot
    const overwrites = [
      { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
      { id: userId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles] },
      { id: guild.members.me.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles, PermissionsBitField.Flags.EmbedLinks] },
    ];

    for (const rid of cfg.SUPPORT_ROLE_IDS) {
      overwrites.push({
        id: rid,
        allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles],
      });
    }

    // report tickets: extra strict (still same roles, but we’ll mark sensitive in logs)
    const ch = await guild.channels
      .create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: parent.id,
        permissionOverwrites: overwrites,
        topic: `Ticket ${ticketId} • ${categoryKey} • Owner ${userId}`,
      })
      .catch(() => null);

    if (!ch) return interaction.reply({ content: "❌ Failed to create ticket channel.", ephemeral: true });

    ticket.channelId = ch.id;
    db.tickets[ticketId] = ticket;
    addOpenForUser(userId, ticketId);
    persist();

    scheduleEscalation(interaction.client, ticketId);

    const intro = buildTicketIntroEmbed(brand, ticket);
    const controls = buildTicketControlsRow(ticket.state);

    await safeSend(ch, { content: `<@${userId}>`, embeds: [intro], components: controls });

    // log creation
    await log(guild, "🎫 Ticket Created", [
      { name: "Ticket", value: `<#${ch.id}> • \`${ticketId}\``, inline: false },
      { name: "Owner", value: `<@${userId}>`, inline: true },
      { name: "Category", value: `${categoryKey}${categoryKey === "report" ? " (Sensitive)" : ""}`, inline: true },
    ]);

    await interaction.reply({ content: `✅ Ticket created: <#${ch.id}>`, ephemeral: true });
  }

  function getTicketFromChannel(channel) {
    if (!channel?.topic) return null;
    const m = channel.topic.match(/Ticket\s+(T[0-9a-z]+)\b/i);
    if (!m) return null;
    const id = m[1].toUpperCase();
    return db.tickets[id] || null;
  }

  async function markStaffSeenIfNeeded(message, ticket) {
    if (!ticket || ticket.staffSeenAt) return;

    const cfg = getConfig();
    const member = message.member;
    if (!isStaff(member, cfg.SUPPORT_ROLE_IDS)) return;

    ticket.staffSeenAt = nowSec();
    persist();

    const seenEmbed = new EmbedBuilder()
      .setColor(brand.COLOR_ACCENT)
      .setDescription(`👀 **Staff has seen this ticket.**`)
      .setFooter({ text: brand.FOOTER });

    await safeSend(message.channel, { embeds: [seenEmbed] });
  }

  async function markFirstStaffResponseIfNeeded(message, ticket) {
    if (!ticket) return;

    const cfg = getConfig();
    const member = message.member;
    if (!isStaff(member, cfg.SUPPORT_ROLE_IDS)) return;

    // first staff response timestamp (for SLA/metrics)
    if (!ticket.staffFirstResponseAt) {
      ticket.staffFirstResponseAt = nowSec();
      persist();

      // store metrics: first response time from creation
      const sec = ticket.staffFirstResponseAt - ticket.createdAt;
      const m = ensureStaffMetric(member.id);
      m.firstResponses.push(sec);
      persist();
    }
  }

  async function handleClaim(interaction, ticket) {
    const cfg = getConfig();
    if (!isStaff(interaction.member, cfg.SUPPORT_ROLE_IDS)) return interaction.reply({ content: "❌ Staff only.", ephemeral: true });
    if (!ticket) return interaction.reply({ content: "❌ Ticket not found.", ephemeral: true });

    // mark "seen" on claim too
    if (!ticket.staffSeenAt) {
      ticket.staffSeenAt = nowSec();
    }

    ticket.claimedBy = interaction.user.id;
    if (ticket.state !== "CLOSED") ticket.state = "CLAIMED";
    persist();

    const m = ensureStaffMetric(interaction.user.id);
    m.claims += 1;
    persist();

    await safeSend(interaction.channel, {
      embeds: [
        new EmbedBuilder()
          .setColor(brand.COLOR_PRIMARY)
          .setDescription(`🧷 **Claimed by** <@${interaction.user.id}>`)
          .setFooter({ text: brand.FOOTER }),
      ],
    });

    await log(interaction.guild, "🧷 Ticket Claimed", [
      { name: "Ticket", value: `<#${ticket.channelId}> • \`${ticket.ticketId}\``, inline: false },
      { name: "Staff", value: `<@${interaction.user.id}>`, inline: true },
    ]);

    // update controls
    const [row1, row2] = buildTicketControlsRow(ticket.state === "CLOSED" ? "CLOSED" : ticket.state);
    const last = await interaction.channel.messages.fetch({ limit: 10 }).catch(() => null);
    const panelMsg = last?.find((x) => x.author?.id === interaction.client.user.id && x.components?.length);
    if (panelMsg) await safeEdit(panelMsg, { components: [row1, row2] });

    return interaction.reply({ content: "✅ Claimed.", ephemeral: true });
  }

  async function handleIncidentToggle(interaction, ticket) {
    const cfg = getConfig();
    if (!isStaff(interaction.member, cfg.SUPPORT_ROLE_IDS)) return interaction.reply({ content: "❌ Staff only.", ephemeral: true });
    if (!ticket) return interaction.reply({ content: "❌ Ticket not found.", ephemeral: true });

    ticket.incident = !ticket.incident;
    persist();

    await safeSend(interaction.channel, {
      embeds: [
        new EmbedBuilder()
          .setColor(ticket.incident ? brand.COLOR_ACCENT : brand.COLOR_NEUTRAL)
          .setDescription(ticket.incident ? "⚠️ **Incident flagged** (staff-only tracking enabled)." : "✅ **Incident cleared**.")
          .setFooter({ text: brand.FOOTER }),
      ],
    });

    await log(interaction.guild, "⚠️ Incident Toggled", [
      { name: "Ticket", value: `<#${ticket.channelId}> • \`${ticket.ticketId}\``, inline: false },
      { name: "By", value: `<@${interaction.user.id}>`, inline: true },
      { name: "State", value: ticket.incident ? "ON" : "OFF", inline: true },
    ]);

    return interaction.reply({ content: "✅ Updated.", ephemeral: true });
  }

  async function handleStaffNoteModal(interaction) {
    const modal = new ModalBuilder().setCustomId("ticket:note:modal").setTitle("Add Staff Note");
    const input = new TextInputBuilder()
      .setCustomId("note")
      .setLabel("Internal note (staff only)")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(900);

    modal.addComponents(new ActionRowBuilder().addComponents(input));
    await interaction.showModal(modal);
  }

  async function handleStaffNoteSubmit(interaction, ticket) {
    const cfg = getConfig();
    if (!isStaff(interaction.member, cfg.SUPPORT_ROLE_IDS)) return interaction.reply({ content: "❌ Staff only.", ephemeral: true });
    if (!ticket) return interaction.reply({ content: "❌ Ticket not found.", ephemeral: true });

    const note = interaction.fields.getTextInputValue("note");
    ticket.staffNotes.push({ by: interaction.user.id, at: nowSec(), note });
    persist();

    await safeSend(interaction.channel, {
      embeds: [
        new EmbedBuilder()
          .setColor(brand.COLOR_NEUTRAL)
          .setTitle("📝 Staff Note")
          .setDescription(note)
          .addFields({ name: "By", value: `<@${interaction.user.id}>`, inline: true }, { name: "When", value: `<t:${nowSec()}:R>`, inline: true })
          .setFooter({ text: brand.FOOTER }),
      ],
    });

    await log(interaction.guild, "📝 Staff Note Added", [
      { name: "Ticket", value: `<#${ticket.channelId}> • \`${ticket.ticketId}\``, inline: false },
      { name: "By", value: `<@${interaction.user.id}>`, inline: true },
    ]);

    return interaction.reply({ content: "✅ Note added.", ephemeral: true });
  }

  async function handleAddUser(interaction, ticket) {
    const cfg = getConfig();
    if (!isStaff(interaction.member, cfg.SUPPORT_ROLE_IDS)) return interaction.reply({ content: "❌ Staff only.", ephemeral: true });
    if (!ticket) return interaction.reply({ content: "❌ Ticket not found.", ephemeral: true });

    // ask for user id via modal (simple + reliable)
    const modal = new ModalBuilder().setCustomId("ticket:adduser:modal").setTitle("Add User to Ticket");
    const input = new TextInputBuilder()
      .setCustomId("userid")
      .setLabel("Discord User ID to add")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(25);

    modal.addComponents(new ActionRowBuilder().addComponents(input));
    await interaction.showModal(modal);
  }

  async function handleAddUserSubmit(interaction, ticket) {
    const cfg = getConfig();
    if (!isStaff(interaction.member, cfg.SUPPORT_ROLE_IDS)) return interaction.reply({ content: "❌ Staff only.", ephemeral: true });
    if (!ticket) return interaction.reply({ content: "❌ Ticket not found.", ephemeral: true });

    const uid = interaction.fields.getTextInputValue("userid").trim().replace(/[<@!>]/g, "");
    if (!/^\d{16,22}$/.test(uid)) return interaction.reply({ content: "❌ That doesn’t look like a valid user ID.", ephemeral: true });

    const channel = interaction.channel;
    await channel.permissionOverwrites.edit(uid, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      AttachFiles: true,
    }).catch(() => null);

    ticket.addedUsers.push(uid);
    persist();

    await safeSend(channel, {
      embeds: [
        new EmbedBuilder()
          .setColor(brand.COLOR_PRIMARY)
          .setDescription(`➕ Added user: <@${uid}>`)
          .setFooter({ text: brand.FOOTER }),
      ],
    });

    await log(interaction.guild, "➕ User Added to Ticket", [
      { name: "Ticket", value: `<#${ticket.channelId}> • \`${ticket.ticketId}\``, inline: false },
      { name: "Added", value: `<@${uid}>`, inline: true },
      { name: "By", value: `<@${interaction.user.id}>`, inline: true },
    ]);

    return interaction.reply({ content: "✅ User added.", ephemeral: true });
  }

  async function handleClose(interaction, ticket) {
    const cfg = getConfig();
    if (!isStaff(interaction.member, cfg.SUPPORT_ROLE_IDS)) return interaction.reply({ content: "❌ Staff only.", ephemeral: true });
    if (!ticket) return interaction.reply({ content: "❌ Ticket not found.", ephemeral: true });
    if (ticket.state === "CLOSED") return interaction.reply({ content: "Already closed.", ephemeral: true });

    // modal for close reason
    const modal = new ModalBuilder().setCustomId("ticket:close:modal").setTitle("Close Ticket");
    const input = new TextInputBuilder()
      .setCustomId("reason")
      .setLabel("Close reason (visible to staff + logged)")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(900);

    modal.addComponents(new ActionRowBuilder().addComponents(input));
    await interaction.showModal(modal);
  }

  async function handleCloseSubmit(interaction, ticket) {
    const cfg = getConfig();
    if (!isStaff(interaction.member, cfg.SUPPORT_ROLE_IDS)) return interaction.reply({ content: "❌ Staff only.", ephemeral: true });
    if (!ticket) return interaction.reply({ content: "❌ Ticket not found.", ephemeral: true });

    const reason = interaction.fields.getTextInputValue("reason");
    ticket.state = "CLOSED";
    ticket.closedAt = nowSec();
    ticket.closeReason = reason;
    persist();

    const m = ensureStaffMetric(interaction.user.id);
    m.closes += 1;
    persist();

    // lock channel (owner can read, but cannot send)
    await interaction.channel.permissionOverwrites.edit(ticket.userId, {
      ViewChannel: true,
      SendMessages: false,
      ReadMessageHistory: true,
      AttachFiles: false,
    }).catch(() => null);

    // transcript
    const transcript = await createTranscript(interaction.channel);

    // attachments vault
    const vaultCh = await fetchTextChannel(interaction.guild, cfg.TICKET_ATTACHMENTS_VAULT_CHANNEL_ID);
    if (vaultCh && transcript.attachmentUrls.length) {
      for (const a of transcript.attachmentUrls.slice(0, 25)) {
        await safeSend(vaultCh, {
          content: `📎 Ticket \`${ticket.ticketId}\` • <#${ticket.channelId}>\n${a.url}`,
        });
      }
    }

    // send transcript to transcript channel
    const trCh = await fetchTextChannel(interaction.guild, cfg.TICKET_TRANSCRIPT_CHANNEL_ID);
    if (trCh) {
      await safeSend(trCh, {
        content: `🧾 Transcript • \`${ticket.ticketId}\` • <#${ticket.channelId}> • Owner <@${ticket.userId}>`,
        files: [transcript.file],
      });
    }

    // log close
    await log(interaction.guild, "🔒 Ticket Closed", [
      { name: "Ticket", value: `<#${ticket.channelId}> • \`${ticket.ticketId}\``, inline: false },
      { name: "By", value: `<@${interaction.user.id}>`, inline: true },
      { name: "Reason", value: reason.slice(0, 900), inline: false },
    ]);

    // in-channel close notice + reopen button
    const [row1, row2] = buildTicketControlsRow("CLOSED");
    await safeSend(interaction.channel, {
      embeds: [
        new EmbedBuilder()
          .setColor(brand.COLOR_DARK)
          .setTitle("🔒 Ticket Closed")
          .setDescription(`Closed by <@${interaction.user.id}>\n\n**Reason:**\n${reason}`)
          .setFooter({ text: brand.FOOTER }),
      ],
      components: [row1, row2],
    });

    // DM rating to user (silent if fails)
    const ratingRow = new ActionRowBuilder().addComponents(
      [1, 2, 3, 4, 5].map((n) =>
        new ButtonBuilder()
          .setCustomId(`ticket:rate:${ticket.ticketId}:${n}`)
          .setLabel(String(n))
          .setStyle(n >= 4 ? ButtonStyle.Success : n === 3 ? ButtonStyle.Secondary : ButtonStyle.Danger)
      )
    );

    const user = await interaction.client.users.fetch(ticket.userId).catch(() => null);
    if (user) {
      await user
        .send({
          embeds: [
            new EmbedBuilder()
              .setColor(brand.COLOR_ACCENT)
              .setTitle(`⭐ Rate your support (${brand.BRAND})`)
              .setDescription(`Please rate this ticket 1–5.\nTicket: \`${ticket.ticketId}\``)
              .setFooter({ text: brand.FOOTER }),
          ],
          components: [ratingRow],
        })
        .catch(async () => {
          await log(interaction.guild, "⭐ Rating DM Failed", [
            { name: "Ticket", value: `\`${ticket.ticketId}\``, inline: true },
            { name: "User", value: `<@${ticket.userId}>`, inline: true },
          ]);
        });
    }

    // auto archive: after N hours, attempt delete channel (optional)
    const hours = cfg.AUTO_ARCHIVE_HOURS;
    setTimeout(async () => {
      try {
        const ch = await interaction.guild.channels.fetch(ticket.channelId).catch(() => null);
        if (!ch) return;
        // Only delete if still closed
        const t2 = db.tickets[ticket.ticketId];
        if (!t2 || t2.state !== "CLOSED") return;
        await ch.delete("Auto-archive closed ticket").catch(() => {});
      } catch {}
    }, hours * 60 * 60 * 1000);

    return interaction.reply({ content: "✅ Closed + transcript saved.", ephemeral: true });
  }

  async function handleReopen(interaction, ticket) {
    const cfg = getConfig();
    if (!ticket) return interaction.reply({ content: "❌ Ticket not found.", ephemeral: true });
    if (ticket.state !== "CLOSED") return interaction.reply({ content: "Ticket isn’t closed.", ephemeral: true });

    // allow owner OR staff
    const isOwner = interaction.user.id === ticket.userId;
    const staff = isStaff(interaction.member, cfg.SUPPORT_ROLE_IDS);
    if (!isOwner && !staff) return interaction.reply({ content: "❌ Only the ticket owner or staff can reopen.", ephemeral: true });

    ticket.state = "REOPENED";
    ticket.closedAt = null;
    ticket.closeReason = null;
    ticket.escalatedAt = null;
    ticket.staffFirstResponseAt = null;
    ticket.staffSeenAt = null;
    persist();

    // unlock owner
    await interaction.channel.permissionOverwrites.edit(ticket.userId, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      AttachFiles: true,
    }).catch(() => null);

    addOpenForUser(ticket.userId, ticket.ticketId);
    persist();

    scheduleEscalation(interaction.client, ticket.ticketId);

    await safeSend(interaction.channel, {
      embeds: [
        new EmbedBuilder()
          .setColor(brand.COLOR_PRIMARY)
          .setTitle("🔓 Ticket Reopened")
          .setDescription(`Reopened by <@${interaction.user.id}>`)
          .setFooter({ text: brand.FOOTER }),
      ],
      components: buildTicketControlsRow("OPEN"),
    });

    await log(interaction.guild, "🔓 Ticket Reopened", [
      { name: "Ticket", value: `<#${ticket.channelId}> • \`${ticket.ticketId}\``, inline: false },
      { name: "By", value: `<@${interaction.user.id}>`, inline: true },
    ]);

    return interaction.reply({ content: "✅ Reopened.", ephemeral: true });
  }

  async function handleRating(interaction, ticketId, rating) {
    const t = db.tickets[ticketId];
    if (!t) return interaction.reply({ content: "Ticket not found.", ephemeral: true });

    if (interaction.user.id !== t.userId) return interaction.reply({ content: "❌ Only the ticket owner can rate.", ephemeral: true });
    if (t.rating) return interaction.reply({ content: "✅ Rating already submitted.", ephemeral: true });

    const r = clamp(parseInt(rating, 10) || 0, 1, 5);
    t.rating = r;
    persist();

    const guild = await interaction.client.guilds.fetch(t.guildId).catch(() => null);
    if (guild) {
      await log(guild, "⭐ Ticket Rated", [
        { name: "Ticket", value: `\`${t.ticketId}\` • <#${t.channelId}>`, inline: false },
        { name: "User", value: `<@${t.userId}>`, inline: true },
        { name: "Rating", value: `**${r} / 5**`, inline: true },
      ]);
    }

    return interaction.reply({ content: `✅ Thanks! You rated **${r}/5**.`, ephemeral: true });
  }

  async function staffStats(interaction) {
    const cfg = getConfig();
    if (!isStaff(interaction.member, cfg.SUPPORT_ROLE_IDS)) return interaction.reply({ content: "❌ Staff only.", ephemeral: true });

    const entries = Object.entries(db.metrics.staff);
    if (!entries.length) return interaction.reply({ content: "No metrics yet.", ephemeral: true });

    const lines = entries
      .slice()
      .sort((a, b) => (b[1].closes || 0) - (a[1].closes || 0))
      .slice(0, 15)
      .map(([uid, m], i) => {
        const avgFirst = m.firstResponses?.length ? `${avg(m.firstResponses)}s` : "—";
        return `**${i + 1}.** <@${uid}> • claims: **${m.claims || 0}** • closes: **${m.closes || 0}** • avg first response: **${avgFirst}**`;
      });

    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(brand.COLOR_ACCENT)
          .setTitle(`📈 ${brand.BRAND} — Staff Metrics`)
          .setDescription(lines.join("\n"))
          .setFooter({ text: brand.FOOTER }),
      ],
      ephemeral: true,
    });
  }

  // ===== exported handlers =====

  async function onMessageCreate(message) {
    if (!message.guild || message.author.bot) return;
    const ticket = getTicketFromChannel(message.channel);
    if (!ticket) return;

    // staff seen indicator
    await markStaffSeenIfNeeded(message, ticket);

    // first staff response metrics + stops escalation
    await markFirstStaffResponseIfNeeded(message, ticket);
  }

  async function onInteractionCreate(interaction) {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "tickets") {
        const sub = interaction.options.getSubcommand();
        if (sub === "panel") return postPanel(interaction);
        if (sub === "staffstats") return staffStats(interaction);
      }
      return;
    }

    if (!interaction.isButton() && !interaction.isModalSubmit()) return;

    // button creates (panel)
    if (interaction.isButton() && interaction.customId.startsWith("ticket:create:")) {
      const key = interaction.customId.split(":")[2];
      return createTicket(interaction, key);
    }

    // rating buttons in DMs
    if (interaction.isButton() && interaction.customId.startsWith("ticket:rate:")) {
      const [, , ticketId, rating] = interaction.customId.split(":");
      return handleRating(interaction, ticketId, rating);
    }

    // In-channel actions: need ticket from channel topic
    const ticket = getTicketFromChannel(interaction.channel);

    // buttons
    if (interaction.isButton() && interaction.customId === "ticket:claim") return handleClaim(interaction, ticket);
    if (interaction.isButton() && interaction.customId === "ticket:incident") return handleIncidentToggle(interaction, ticket);

    if (interaction.isButton() && interaction.customId === "ticket:note") {
      const cfg = getConfig();
      if (!isStaff(interaction.member, cfg.SUPPORT_ROLE_IDS)) return interaction.reply({ content: "❌ Staff only.", ephemeral: true });
      return handleStaffNoteModal(interaction);
    }

    if (interaction.isModalSubmit() && interaction.customId === "ticket:note:modal") return handleStaffNoteSubmit(interaction, ticket);

    if (interaction.isButton() && interaction.customId === "ticket:adduser") return handleAddUser(interaction, ticket);
    if (interaction.isModalSubmit() && interaction.customId === "ticket:adduser:modal") return handleAddUserSubmit(interaction, ticket);

    if (interaction.isButton() && interaction.customId === "ticket:close") return handleClose(interaction, ticket);
    if (interaction.isModalSubmit() && interaction.customId === "ticket:close:modal") {
      // ticket can be null if topic missing; handle anyway
      const t2 = ticket || getTicketFromChannel(interaction.channel);
      return handleCloseSubmit(interaction, t2);
    }

    if (interaction.isButton() && interaction.customId === "ticket:reopen") return handleReopen(interaction, ticket);
  }

  function getSlashCommands() {
    return [
      {
        name: "tickets",
        description: "Ticket system admin/staff tools",
        options: [
          { type: 1, name: "panel", description: "Post the ticket panel in this channel" },
          { type: 1, name: "staffstats", description: "Show staff ticket metrics" },
        ],
        default_member_permissions: null, // we do permissions checks in code
      },
    ];
  }

  return {
    onMessageCreate,
    onInteractionCreate,
    getSlashCommands,
  };
}

module.exports = { initTicketSystem };

const fs = require("fs");
const path = require("path");
const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  ChannelType,
} = require("discord.js");

// ================== BRAND (match your neon theme) ==================
const TICKET_BRAND = "🌀 SPIRALS 3X";
const COLOR_CYAN = 0x00e5ff;   // neon cyan
const COLOR_PURPLE = 0xb000ff; // neon purple

// ================== DATA ==================
const DATA_DIR = path.join(__dirname, "data");
const TICKETS_FILE = path.join(DATA_DIR, "tickets.json");

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

const db = loadJsonSafe(TICKETS_FILE, { tickets: {} }); // ticketId -> ticket
function saveDb() {
  saveJson(TICKETS_FILE, db);
}

function makeId() {
  return `t_${Date.now().toString(36)}_${Math.floor(Math.random() * 9999)}`;
}

// ================== COMMANDS ==================
function getTicketCommands() {
  return [
    new SlashCommandBuilder()
      .setName("ticketpanel")
      .setDescription("Post the SPIRALS 3X support ticket panel.")
      .addChannelOption((o) =>
        o
          .setName("channel")
          .setDescription("Where to post the panel (defaults to current channel)")
          .setRequired(false)
      )
      .addChannelOption((o) =>
        o
          .setName("category")
          .setDescription("Category to create ticket channels under (recommended)")
          .setRequired(false)
      )
      .addRoleOption((o) =>
        o
          .setName("support_role_1")
          .setDescription("Support role that can view tickets")
          .setRequired(true)
      )
      .addRoleOption((o) =>
        o
          .setName("support_role_2")
          .setDescription("Optional 2nd support role")
          .setRequired(false)
      )
      .addRoleOption((o) =>
        o
          .setName("support_role_3")
          .setDescription("Optional 3rd support role")
          .setRequired(false)
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  ].map((c) => c.toJSON());
}

// ================== PANEL UI ==================
function panelEmbed() {
  return new EmbedBuilder()
    .setColor(COLOR_PURPLE)
    .setTitle(`${TICKET_BRAND} • Support`)
    .setDescription(
      [
        "Tap a button to open a private support ticket.",
        "",
        "🛒 **Shop Issue** — purchases, items, rewards, store problems",
        "🚫 **Report Player** — cheating, abuse, rule breaks",
        "🧩 **General Support** — anything else",
        "",
        "_Tickets open as a private channel with staff._",
      ].join("\n")
    );
}

function panelButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("ticket_open_shop").setLabel("Shop Issue").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ticket_open_report").setLabel("Report Player").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("ticket_open_general").setLabel("General Support").setStyle(ButtonStyle.Secondary)
  );
}

function ticketStaffButtons(ticketId, state) {
  const row = new ActionRowBuilder();

  row.addComponents(
    new ButtonBuilder().setCustomId(`ticket_claim:${ticketId}`).setLabel("Claim").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`ticket_close:${ticketId}`).setLabel("Close").setStyle(ButtonStyle.Danger)
  );

  if (state === "CLOSED") {
    row.addComponents(
      new ButtonBuilder().setCustomId(`ticket_reopen:${ticketId}`).setLabel("Reopen").setStyle(ButtonStyle.Secondary)
    );
  }

  return row;
}

// ================== CORE ==================
function initTicketSystem() {
  ensureDir(DATA_DIR);
  if (!fs.existsSync(TICKETS_FILE)) saveDb();

  // store latest panel config per guild (simple + effective)
  const panelConfigByGuild = new Map(); // guildId -> { categoryId, supportRoleIds[], panelChannelId }

  async function handleTicketPanelCommand(interaction) {
    const guild = interaction.guild;
    const channel = interaction.options.getChannel("channel") || interaction.channel;
    const category = interaction.options.getChannel("category") || null;

    const r1 = interaction.options.getRole("support_role_1", true);
    const r2 = interaction.options.getRole("support_role_2") || null;
    const r3 = interaction.options.getRole("support_role_3") || null;

    const supportRoleIds = [r1?.id, r2?.id, r3?.id].filter(Boolean);

    panelConfigByGuild.set(guild.id, {
      panelChannelId: channel.id,
      categoryId: category?.id || null,
      supportRoleIds,
    });

    await channel.send({ embeds: [panelEmbed()], components: [panelButtons()] });
    await interaction.reply({ content: `✅ Panel posted in <#${channel.id}>`, ephemeral: true });
    return true;
  }

  function ticketTypeLabel(type) {
    if (type === "shop") return "🛒 Shop Issue";
    if (type === "report") return "🚫 Report Player";
    return "🧩 General Support";
  }

  async function createTicketChannel(interaction, type) {
    const guild = interaction.guild;
    const user = interaction.user;

    const cfg = panelConfigByGuild.get(guild.id);
    if (!cfg) {
      await interaction.reply({
        content: "❌ Ticket panel not configured yet. Ask an admin to run `/ticketpanel` first.",
        ephemeral: true,
      });
      return true;
    }

    // prevent duplicate open tickets per user (simple anti-abuse)
    const existing = Object.values(db.tickets).find(
      (t) => t.guildId === guild.id && t.userId === user.id && t.state !== "CLOSED"
    );
    if (existing) {
      await interaction.reply({ content: `⚠️ You already have an open ticket: <#${existing.channelId}>`, ephemeral: true });
      return true;
    }

    const ticketId = makeId();
    const name = `ticket-${type}-${user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 90);

    const overwrites = [
      { id: guild.roles.everyone.id, deny: ["ViewChannel"] },
      { id: user.id, allow: ["ViewChannel", "SendMessages", "ReadMessageHistory", "AttachFiles", "EmbedLinks"] },
    ];

    for (const rid of cfg.supportRoleIds) {
      overwrites.push({ id: rid, allow: ["ViewChannel", "SendMessages", "ReadMessageHistory", "ManageMessages"] });
    }

    const ch = await guild.channels.create({
      name,
      type: ChannelType.GuildText,
      parent: cfg.categoryId || undefined,
      permissionOverwrites: overwrites,
      topic: `Ticket ${ticketId} • ${ticketTypeLabel(type)} • User ${user.id}`,
    });

    db.tickets[ticketId] = {
      id: ticketId,
      guildId: guild.id,
      channelId: ch.id,
      userId: user.id,
      type,
      state: "OPEN",
      createdAt: Date.now(),
      claimedBy: null,
      closedAt: null,
    };
    saveDb();

    const intro = new EmbedBuilder()
      .setColor(COLOR_CYAN)
      .setTitle(`${ticketTypeLabel(type)} • ${TICKET_BRAND}`)
      .setDescription(
        [
          `👤 **Player:** <@${user.id}>`,
          "",
          "Explain the problem clearly and include any screenshots if needed.",
          "",
          "Staff can **Claim** then **Close** when resolved.",
        ].join("\n")
      );

    await ch.send({ content: `<@${user.id}>`, embeds: [intro], components: [ticketStaffButtons(ticketId, "OPEN")] });

    await interaction.reply({ content: `✅ Ticket created: <#${ch.id}>`, ephemeral: true });
    return true;
  }

  async function claimTicket(interaction, ticketId) {
    const t = db.tickets[ticketId];
    if (!t) return interaction.reply({ content: "❌ Ticket not found.", ephemeral: true });

    t.claimedBy = interaction.user.id;
    saveDb();

    await interaction.reply({ content: `✅ Claimed by <@${interaction.user.id}>`, ephemeral: false }).catch(() => {});
    return true;
  }

  async function closeTicket(interaction, ticketId) {
    const t = db.tickets[ticketId];
    if (!t) return interaction.reply({ content: "❌ Ticket not found.", ephemeral: true });

    t.state = "CLOSED";
    t.closedAt = Date.now();
    saveDb();

    const e = new EmbedBuilder()
      .setColor(COLOR_PURPLE)
      .setTitle(`${TICKET_BRAND} • Ticket Closed`)
      .setDescription("This ticket is now closed. Staff can reopen if needed.");

    await interaction.channel.send({ embeds: [e], components: [ticketStaffButtons(ticketId, "CLOSED")] }).catch(() => {});
    return interaction.reply({ content: "✅ Closed.", ephemeral: true });
  }

  async function reopenTicket(interaction, ticketId) {
    const t = db.tickets[ticketId];
    if (!t) return interaction.reply({ content: "❌ Ticket not found.", ephemeral: true });

    t.state = "OPEN";
    t.closedAt = null;
    saveDb();

    const e = new EmbedBuilder()
      .setColor(COLOR_CYAN)
      .setTitle(`${TICKET_BRAND} • Ticket Reopened`)
      .setDescription("Ticket reopened. Continue the discussion below.");

    await interaction.channel.send({ embeds: [e], components: [ticketStaffButtons(ticketId, "OPEN")] }).catch(() => {});
    return interaction.reply({ content: "✅ Reopened.", ephemeral: true });
  }

  async function handleInteraction(interaction) {
    // /ticketpanel command
    if (interaction.isChatInputCommand() && interaction.commandName === "ticketpanel") {
      return handleTicketPanelCommand(interaction);
    }

    // buttons
    if (interaction.isButton()) {
      const id = interaction.customId;

      if (id === "ticket_open_shop") return createTicketChannel(interaction, "shop");
      if (id === "ticket_open_report") return createTicketChannel(interaction, "report");
      if (id === "ticket_open_general") return createTicketChannel(interaction, "general");

      if (id.startsWith("ticket_claim:")) return claimTicket(interaction, id.split(":")[1]);
      if (id.startsWith("ticket_close:")) return closeTicket(interaction, id.split(":")[1]);
      if (id.startsWith("ticket_reopen:")) return reopenTicket(interaction, id.split(":")[1]);
    }

    return false;
  }

  return {
    commands: getTicketCommands(),
    handleInteraction,
  };
}

module.exports = { initTicketSystem };
