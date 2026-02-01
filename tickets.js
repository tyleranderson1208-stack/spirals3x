"use strict";

/**
 * SPIRALS 3X — Ticket System (panel-style channels, no threads)
 * - Multiple support roles per panel
 * - Buttons: Create, Close, Reopen, Claim/Unclaim, Add Note, Transcript
 * - Ticket states, staff seen indicator, silent escalation
 * - Cooldown + abuse prevention
 * - Rating 1–5 after close
 * - Logs + transcripts to an optional log channel
 *
 * Requires: discord.js v14
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
  PermissionFlagsBits,
  PermissionsBitField,
} = require("discord.js");

/* ===================== CONFIG + STORAGE ===================== */

const BRAND = "🌀 SPIRALS 3X";
const COLOR_PRIMARY = 0x00e5ff; // neon cyan
const COLOR_ACCENT = 0xb400ff;  // neon purple
const COLOR_DARK = 0x0a0012;

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
  const bak = `${file}.bak`;
  try {
    if (fs.existsSync(file)) {
      try { fs.copyFileSync(file, bak); } catch {}
    }
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
    fs.renameSync(tmp, file);
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
    console.error("saveJson error:", e?.message || e);
  }
}

// DB schema:
// {
//   panels: {
//     [guildId]: {
//       [panelChannelId]: {
//         createdAt, createdBy,
//         supportRoleIds: string[],
//         logChannelId: string | "",
//         categoryId: string | "",
//         panelTitle: string,
//         panelDescription: string,
//         allowAttachments: boolean,
//         cooldownSec: number,
//         maxOpenPerUser: number
//       }
//     }
//   },
//   tickets: {
//     [guildId]: {
//       [ticketChannelId]: {
//         id, createdAt, createdBy,
//         panelChannelId,
//         typeKey,
//         state: "OPEN"|"CLOSED",
//         claimedBy: string|null,
//         lastStaffSeenAt: number,
//         lastUserMsgAt: number,
//         closeMeta: { closedAt, closedBy, reason } | null,
//         rating: { score, ratedAt } | null,
//         staffNotes: [{ at, by, note }]
//       }
//     }
//   },
//   cooldowns: { [guildId]: { [userId]: lastCreateAtSec } }
// }

const DEFAULT_DB = { panels: {}, tickets: {}, cooldowns: {} };
const db = loadJsonSafe(TICKETS_FILE, { ...DEFAULT_DB });
saveJson(TICKETS_FILE, db);

/* ===================== HELPERS ===================== */

function nowSec() {
  return Math.floor(Date.now() / 1000);
}
function tag(uid) {
  return `<@${uid}>`;
}
function rid() {
  return crypto.randomBytes(6).toString("hex");
}
function safeArr(x) {
  return Array.isArray(x) ? x : [];
}
function getGuildPanels(guildId) {
  if (!db.panels[guildId]) db.panels[guildId] = {};
  return db.panels[guildId];
}
function getGuildTickets(guildId) {
  if (!db.tickets[guildId]) db.tickets[guildId] = {};
  return db.tickets[guildId];
}
function getGuildCooldowns(guildId) {
  if (!db.cooldowns[guildId]) db.cooldowns[guildId] = {};
  return db.cooldowns[guildId];
}
function persist() {
  saveJson(TICKETS_FILE, db);
}

const TICKET_TYPES = [
  { key: "shop", label: "🛒 Shop Issue (Spirals / purchases)", desc: "Missing items, wrong items, Spirals not received, etc." },
  { key: "report", label: "🚨 Report a Player", desc: "Cheating, harassment, scamming, rule-breaking." },
  { key: "exploit", label: "🧪 Bug / Exploit", desc: "Game-breaking issues, exploits, duplication, etc." },
  { key: "general", label: "💬 General Support", desc: "Anything else." },
];

function typeByKey(k) {
  return TICKET_TYPES.find((t) => t.key === k) || TICKET_TYPES[3];
}

function header(title) {
  return `**${title}** • ${BRAND}`;
}

function staffRolesMention(roleIds) {
  const ids = safeArr(roleIds).filter(Boolean);
  return ids.length ? ids.map((id) => `<@&${id}>`).join(" ") : "`No support roles set`";
}

function userOpenTicketsCount(guildId, userId) {
  const tickets = Object.values(getGuildTickets(guildId));
  return tickets.filter((t) => t.createdBy === userId && t.state === "OPEN").length;
}

function isSupport(member, panel) {
  if (!member) return false;
  if (member.permissions?.has(PermissionsBitField.Flags.Administrator)) return true;
  const roles = safeArr(panel?.supportRoleIds);
  return roles.some((rid) => member.roles?.cache?.has(rid));
}

function canSeeTicket(member, ticket, panel) {
  if (!member) return false;
  if (member.user?.id === ticket.createdBy) return true;
  return isSupport(member, panel);
}

function channelNameFor(user, typeKey) {
  const base = typeKey || "ticket";
  const safe = (user?.username || "user").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 10) || "user";
  return `ticket-${base}-${safe}-${Math.floor(Math.random() * 900 + 100)}`;
}

async function sendLog(guild, panel, embed) {
  const logId = panel?.logChannelId;
  if (!logId) return;
  const ch = await guild.channels.fetch(logId).catch(() => null);
  if (!ch || !("send" in ch)) return;
  await ch.send({ embeds: [embed] }).catch(() => {});
}

/* ===================== UI BUILDERS ===================== */

function panelEmbed(panel, guild) {
  const rolesText = staffRolesMention(panel.supportRoleIds);
  const typesText = TICKET_TYPES.map((t) => `• **${t.label}** — ${t.desc}`).join("\n");

  return new EmbedBuilder()
    .setColor(COLOR_PRIMARY)
    .setTitle(`🌀 ${BRAND} — Support Panel`)
    .setDescription(
      `${header(panel.panelTitle || "NEED HELP?")}\n\n` +
        `${panel.panelDescription || "Pick a category and open a private ticket channel with staff."}\n\n` +
        `**Available categories:**\n${typesText}\n\n` +
        `**Support roles:**\n${rolesText}\n\n` +
        `⚠️ Abuse/spam will be actioned.`
    )
    .setFooter({ text: guild?.name || BRAND });
}

function panelButtonsRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("ticket:create:shop").setLabel("Shop Issue").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ticket:create:report").setLabel("Report Player").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ticket:create:exploit").setLabel("Bug/Exploit").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ticket:create:general").setLabel("General").setStyle(ButtonStyle.Secondary)
  );
}

function ticketControlsRow(ticket) {
  const claimed = !!ticket.claimedBy;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("ticket:claim")
      .setLabel(claimed ? "Claimed" : "Claim")
      .setStyle(claimed ? ButtonStyle.Secondary : ButtonStyle.Primary)
      .setDisabled(claimed),
    new ButtonBuilder()
      .setCustomId("ticket:unclaim")
      .setLabel("Unclaim")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!claimed),
    new ButtonBuilder().setCustomId("ticket:note").setLabel("Add Note").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ticket:transcript").setLabel("Transcript").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(ticket.state === "OPEN" ? "ticket:close" : "ticket:reopen")
      .setLabel(ticket.state === "OPEN" ? "Close" : "Reopen")
      .setStyle(ticket.state === "OPEN" ? ButtonStyle.Danger : ButtonStyle.Success)
  );
}

function ticketHeaderEmbed(ticket, openerUser, panel) {
  const t = typeByKey(ticket.typeKey);
  const stateText = ticket.state === "OPEN" ? "🟢 OPEN" : "🔴 CLOSED";
  const claimedText = ticket.claimedBy ? `✅ Claimed by ${tag(ticket.claimedBy)}` : "—";
  const rolesText = staffRolesMention(panel?.supportRoleIds);

  return new EmbedBuilder()
    .setColor(ticket.state === "OPEN" ? COLOR_ACCENT : COLOR_DARK)
    .setTitle(`${t.label} — Ticket`)
    .setDescription(
      `${header("TICKET DETAILS")}\n\n` +
        `**Opener:** ${tag(ticket.createdBy)}\n` +
        `**State:** ${stateText}\n` +
        `**Claim:** ${claimedText}\n\n` +
        `**Support roles:**\n${rolesText}\n\n` +
        `Use the buttons below for actions.`
    )
    .setFooter({ text: `Ticket ID: ${ticket.id}` });
}

function ratingRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("ticket:rate:1").setLabel("1").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ticket:rate:2").setLabel("2").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ticket:rate:3").setLabel("3").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ticket:rate:4").setLabel("4").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ticket:rate:5").setLabel("5").setStyle(ButtonStyle.Success)
  );
}

/* ===================== TRANSCRIPT ===================== */

async function buildTranscript(channel) {
  // Grab last ~100 messages
  const msgs = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (!msgs) return null;

  const arr = Array.from(msgs.values()).sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  const lines = arr.map((m) => {
    const ts = new Date(m.createdTimestamp).toISOString();
    const author = `${m.author?.tag || "Unknown"} (${m.author?.id || "?"})`;
    const content = (m.content || "").replace(/\n/g, " ");
    const att = m.attachments?.size ? ` [attachments:${m.attachments.size}]` : "";
    return `[${ts}] ${author}: ${content}${att}`;
  });

  const text = lines.join("\n");
  const fileName = `ticket-transcript-${channel.id}.txt`;
  const outPath = path.join(DATA_DIR, fileName);
  ensureDir(DATA_DIR);
  fs.writeFileSync(outPath, text, "utf8");
  return { outPath, fileName, length: lines.length };
}

/* ===================== CORE: CREATE PANEL ===================== */

function buildTicketPanelCommand(SlashCommandBuilder) {
  return new SlashCommandBuilder()
    .setName("ticketpanel")
    .setDescription("Create or update the Spirals ticket panel in this channel (admin).")
    .addRoleOption((o) => o.setName("support_role_1").setDescription("Support role 1").setRequired(true))
    .addRoleOption((o) => o.setName("support_role_2").setDescription("Support role 2").setRequired(false))
    .addRoleOption((o) => o.setName("support_role_3").setDescription("Support role 3").setRequired(false))
    .addChannelOption((o) =>
      o.setName("log_channel").setDescription("Where transcripts/logs go (optional)").setRequired(false)
    )
    .addChannelOption((o) =>
      o.setName("category").setDescription("Category for new ticket channels (optional)").setRequired(false)
    )
    .addIntegerOption((o) =>
      o.setName("cooldown_sec").setDescription("Cooldown per user to open tickets (default 120)").setRequired(false)
    )
    .addIntegerOption((o) =>
      o.setName("max_open_per_user").setDescription("Max open tickets per user (default 1)").setRequired(false)
    )
    .addStringOption((o) =>
      o.setName("title").setDescription("Panel header title").setRequired(false)
    )
    .addStringOption((o) =>
      o.setName("description").setDescription("Panel description text").setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);
}

async function handleTicketPanel(interaction) {
  const guild = interaction.guild;
  if (!guild) return interaction.reply({ content: "Guild only.", ephemeral: true });

  const r1 = interaction.options.getRole("support_role_1", true);
  const r2 = interaction.options.getRole("support_role_2", false);
  const r3 = interaction.options.getRole("support_role_3", false);

  const logCh = interaction.options.getChannel("log_channel", false);
  const category = interaction.options.getChannel("category", false);

  const cooldownSec = Math.max(10, interaction.options.getInteger("cooldown_sec", false) || 120);
  const maxOpenPerUser = Math.max(1, interaction.options.getInteger("max_open_per_user", false) || 1);

  const title = interaction.options.getString("title", false) || "NEED HELP?";
  const desc = interaction.options.getString("description", false) || "Choose a category below to open a private ticket.";

  const panel = {
    createdAt: nowSec(),
    createdBy: interaction.user.id,
    supportRoleIds: [r1?.id, r2?.id, r3?.id].filter(Boolean),
    logChannelId: logCh?.id || "",
    categoryId: category?.id || "",
    panelTitle: title,
    panelDescription: desc,
    allowAttachments: true,
    cooldownSec,
    maxOpenPerUser,
  };

  const panels = getGuildPanels(guild.id);
  panels[interaction.channelId] = panel;
  persist();

  await interaction.reply({ content: "✅ Ticket panel saved. Posting panel…", ephemeral: true });
  await interaction.channel.send({
    embeds: [panelEmbed(panel, guild)],
    components: [panelButtonsRow()],
  });
}

/* ===================== CORE: CREATE TICKET ===================== */

async function createTicketFromPanel(interaction, typeKey) {
  const guild = interaction.guild;
  if (!guild) return interaction.reply({ content: "Guild only.", ephemeral: true });

  const panels = getGuildPanels(guild.id);
  const panel = panels[interaction.channelId];
  if (!panel) {
    return interaction.reply({ content: "❌ This channel is not a ticket panel.", ephemeral: true });
  }

  // cooldown
  const cds = getGuildCooldowns(guild.id);
  const last = cds[interaction.user.id] || 0;
  const left = last + panel.cooldownSec - nowSec();
  if (left > 0) {
    return interaction.reply({ content: `⏳ Slow down. Try again <t:${nowSec() + left}:R>.`, ephemeral: true });
  }

  // max open tickets
  if (userOpenTicketsCount(guild.id, interaction.user.id) >= panel.maxOpenPerUser) {
    return interaction.reply({ content: `❌ You already have an open ticket. Please close it first.`, ephemeral: true });
  }

  cds[interaction.user.id] = nowSec();
  persist();

  const t = typeByKey(typeKey);

  // channel creation perms
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
  ];

  for (const roleId of safeArr(panel.supportRoleIds)) {
    overwrites.push({
      id: roleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.AttachFiles,
      ],
    });
  }

  const categoryId = panel.categoryId || null;

  const ch = await guild.channels
    .create({
      name: channelNameFor(interaction.user, typeKey),
      type: ChannelType.GuildText,
      parent: categoryId || undefined,
      permissionOverwrites: overwrites,
      topic: `Ticket • ${t.label} • Opener:${interaction.user.id}`,
    })
    .catch((e) => {
      console.error("ticket create channel error:", e?.message || e);
      return null;
    });

  if (!ch) return interaction.reply({ content: "❌ Failed to create ticket channel.", ephemeral: true });

  const ticket = {
    id: rid(),
    createdAt: Date.now(),
    createdBy: interaction.user.id,
    panelChannelId: interaction.channelId,
    typeKey,
    state: "OPEN",
    claimedBy: null,
    lastStaffSeenAt: 0,
    lastUserMsgAt: Date.now(),
    closeMeta: null,
    rating: null,
    staffNotes: [],
  };

  const tickets = getGuildTickets(guild.id);
  tickets[ch.id] = ticket;
  persist();

  await interaction.reply({ content: `✅ Ticket created: <#${ch.id}>`, ephemeral: true });

  // Ticket intro
  await ch.send({
    content: `${tag(interaction.user.id)} — welcome! A support member will be with you shortly.\n` +
      `**Category:** ${t.label}\n` +
      `**Staff ping:** ${staffRolesMention(panel.supportRoleIds)}`,
    embeds: [ticketHeaderEmbed(ticket, interaction.user, panel)],
    components: [ticketControlsRow(ticket)],
  }).catch(() => {});

  await sendLog(
    guild,
    panel,
    new EmbedBuilder()
      .setColor(COLOR_PRIMARY)
      .setTitle(`🎫 Ticket Opened`)
      .setDescription(`**User:** ${tag(ticket.createdBy)}\n**Type:** ${t.label}\n**Channel:** <#${ch.id}>\n**Ticket ID:** ${ticket.id}`)
      .setTimestamp(new Date())
  );
}

/* ===================== CORE: TICKET ACTIONS ===================== */

async function getTicketContext(interaction) {
  const guild = interaction.guild;
  if (!guild) return { guild: null, panel: null, ticket: null, tickets: null };

  const tickets = getGuildTickets(guild.id);
  const ticket = tickets[interaction.channelId];
  if (!ticket) return { guild, panel: null, ticket: null, tickets };

  const panels = getGuildPanels(guild.id);
  const panel = panels[ticket.panelChannelId] || null;

  return { guild, panel, ticket, tickets };
}

async function refreshTicketMessage(channel, ticket, panel) {
  // Refresh by sending a new control message (simple + reliable)
  await channel.send({
    embeds: [ticketHeaderEmbed(ticket, null, panel)],
    components: [ticketControlsRow(ticket)],
  }).catch(() => {});
}

async function handleClaim(interaction) {
  const { guild, panel, ticket, tickets } = await getTicketContext(interaction);
  if (!ticket) return interaction.reply({ content: "Not a ticket channel.", ephemeral: true });

  const member = await guild.members.fetch(interaction.user.id).catch(() => null);
  if (!isSupport(member, panel)) return interaction.reply({ content: "Staff only.", ephemeral: true });

  if (ticket.state !== "OPEN") return interaction.reply({ content: "Ticket is closed.", ephemeral: true });
  if (ticket.claimedBy) return interaction.reply({ content: "Already claimed.", ephemeral: true });

  ticket.claimedBy = interaction.user.id;
  tickets[interaction.channelId] = ticket;
  persist();

  await interaction.reply({ content: `✅ Claimed by ${tag(interaction.user.id)}`, ephemeral: true });
  await refreshTicketMessage(interaction.channel, ticket, panel);

  await sendLog(
    guild,
    panel,
    new EmbedBuilder()
      .setColor(COLOR_ACCENT)
      .setTitle(`✅ Ticket Claimed`)
      .setDescription(`**By:** ${tag(interaction.user.id)}\n**Channel:** <#${interaction.channelId}>\n**Ticket ID:** ${ticket.id}`)
      .setTimestamp(new Date())
  );
}

async function handleUnclaim(interaction) {
  const { guild, panel, ticket, tickets } = await getTicketContext(interaction);
  if (!ticket) return interaction.reply({ content: "Not a ticket channel.", ephemeral: true });

  const member = await guild.members.fetch(interaction.user.id).catch(() => null);
  if (!isSupport(member, panel)) return interaction.reply({ content: "Staff only.", ephemeral: true });

  if (!ticket.claimedBy) return interaction.reply({ content: "Not claimed.", ephemeral: true });

  ticket.claimedBy = null;
  tickets[interaction.channelId] = ticket;
  persist();

  await interaction.reply({ content: "✅ Unclaimed.", ephemeral: true });
  await refreshTicketMessage(interaction.channel, ticket, panel);
}

async function handleClose(interaction) {
  const { guild, panel, ticket, tickets } = await getTicketContext(interaction);
  if (!ticket) return interaction.reply({ content: "Not a ticket channel.", ephemeral: true });

  const member = await guild.members.fetch(interaction.user.id).catch(() => null);
  // allow opener or staff to close
  const isOpener = interaction.user.id === ticket.createdBy;
  if (!isOpener && !isSupport(member, panel)) return interaction.reply({ content: "No permission.", ephemeral: true });

  if (ticket.state !== "OPEN") return interaction.reply({ content: "Already closed.", ephemeral: true });

  const modal = new ModalBuilder()
    .setCustomId("ticket:close:modal")
    .setTitle("Close Ticket");

  const reason = new TextInputBuilder()
    .setCustomId("reason")
    .setLabel("Reason (short)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(80);

  modal.addComponents(new ActionRowBuilder().addComponents(reason));
  await interaction.showModal(modal);
}

async function handleCloseModal(interaction) {
  const { guild, panel, ticket, tickets } = await getTicketContext(interaction);
  if (!ticket) return interaction.reply({ content: "Not a ticket channel.", ephemeral: true });

  const reason = (interaction.fields.getTextInputValue("reason") || "").trim();

  ticket.state = "CLOSED";
  ticket.closeMeta = { closedAt: Date.now(), closedBy: interaction.user.id, reason: reason || "" };
  tickets[interaction.channelId] = ticket;
  persist();

  // Lock channel for opener (keep visible), keep staff access
  await interaction.channel.permissionOverwrites.edit(ticket.createdBy, {
    SendMessages: false,
    AddReactions: false,
  }).catch(() => {});

  await interaction.reply({ content: "✅ Ticket closed.", ephemeral: true });

  await interaction.channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(COLOR_DARK)
        .setTitle(`🔒 Ticket Closed`)
        .setDescription(
          `${header("CLOSED")}\n\n` +
            `Closed by: ${tag(interaction.user.id)}\n` +
            (reason ? `Reason: **${reason}**\n` : "") +
            `\n**Rate support:** (1–5)`
        ),
    ],
    components: [ratingRow(), ticketControlsRow(ticket)],
  }).catch(() => {});

  await sendLog(
    guild,
    panel,
    new EmbedBuilder()
      .setColor(COLOR_DARK)
      .setTitle(`🔒 Ticket Closed`)
      .setDescription(`**By:** ${tag(interaction.user.id)}\n**Channel:** <#${interaction.channelId}>\n**Ticket ID:** ${ticket.id}\n${reason ? `**Reason:** ${reason}` : ""}`)
      .setTimestamp(new Date())
  );
}

async function handleReopen(interaction) {
  const { guild, panel, ticket, tickets } = await getTicketContext(interaction);
  if (!ticket) return interaction.reply({ content: "Not a ticket channel.", ephemeral: true });

  const member = await guild.members.fetch(interaction.user.id).catch(() => null);
  const isOpener = interaction.user.id === ticket.createdBy;
  if (!isOpener && !isSupport(member, panel)) return interaction.reply({ content: "No permission.", ephemeral: true });

  if (ticket.state !== "CLOSED") return interaction.reply({ content: "Ticket isn't closed.", ephemeral: true });

  ticket.state = "OPEN";
  ticket.closeMeta = null;
  tickets[interaction.channelId] = ticket;
  persist();

  await interaction.channel.permissionOverwrites.edit(ticket.createdBy, {
    SendMessages: true,
    AddReactions: true,
  }).catch(() => {});

  await interaction.reply({ content: "✅ Reopened.", ephemeral: true });
  await refreshTicketMessage(interaction.channel, ticket, panel);
}

async function handleRate(interaction, score) {
  const { guild, panel, ticket, tickets } = await getTicketContext(interaction);
  if (!ticket) return interaction.reply({ content: "Not a ticket channel.", ephemeral: true });

  if (interaction.user.id !== ticket.createdBy) {
    return interaction.reply({ content: "Only the ticket opener can rate.", ephemeral: true });
  }
  if (ticket.state !== "CLOSED") {
    return interaction.reply({ content: "You can rate after closing.", ephemeral: true });
  }
  if (ticket.rating) {
    return interaction.reply({ content: "You already rated this ticket.", ephemeral: true });
  }

  ticket.rating = { score, ratedAt: Date.now() };
  tickets[interaction.channelId] = ticket;
  persist();

  await interaction.reply({ content: `✅ Thanks! Rated: **${score}/5**`, ephemeral: true });

  await sendLog(
    guild,
    panel,
    new EmbedBuilder()
      .setColor(COLOR_PRIMARY)
      .setTitle(`⭐ Ticket Rated`)
      .setDescription(`**User:** ${tag(ticket.createdBy)}\n**Score:** **${score}/5**\n**Channel:** <#${interaction.channelId}>\n**Ticket ID:** ${ticket.id}`)
      .setTimestamp(new Date())
  );
}

async function handleNote(interaction) {
  const { guild, panel, ticket, tickets } = await getTicketContext(interaction);
  if (!ticket) return interaction.reply({ content: "Not a ticket channel.", ephemeral: true });

  const member = await guild.members.fetch(interaction.user.id).catch(() => null);
  if (!isSupport(member, panel)) return interaction.reply({ content: "Staff only.", ephemeral: true });

  const modal = new ModalBuilder().setCustomId("ticket:note:modal").setTitle("Internal Staff Note");
  const note = new TextInputBuilder()
    .setCustomId("note")
    .setLabel("Note (internal)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(800);

  modal.addComponents(new ActionRowBuilder().addComponents(note));
  await interaction.showModal(modal);
}

async function handleNoteModal(interaction) {
  const { guild, panel, ticket, tickets } = await getTicketContext(interaction);
  if (!ticket) return interaction.reply({ content: "Not a ticket channel.", ephemeral: true });

  const note = (interaction.fields.getTextInputValue("note") || "").trim();
  if (!note) return interaction.reply({ content: "Empty note.", ephemeral: true });

  ticket.staffNotes.push({ at: Date.now(), by: interaction.user.id, note });
  tickets[interaction.channelId] = ticket;
  persist();

  await interaction.reply({ content: "✅ Note saved (internal).", ephemeral: true });

  await sendLog(
    guild,
    panel,
    new EmbedBuilder()
      .setColor(COLOR_ACCENT)
      .setTitle(`📝 Staff Note Added`)
      .setDescription(`**By:** ${tag(interaction.user.id)}\n**Channel:** <#${interaction.channelId}>\n**Ticket ID:** ${ticket.id}\n\n${note.slice(0, 500)}${note.length > 500 ? "…" : ""}`)
      .setTimestamp(new Date())
  );
}

async function handleTranscript(interaction) {
  const { guild, panel, ticket } = await getTicketContext(interaction);
  if (!ticket) return interaction.reply({ content: "Not a ticket channel.", ephemeral: true });

  const member = await guild.members.fetch(interaction.user.id).catch(() => null);
  const isOpener = interaction.user.id === ticket.createdBy;
  if (!isOpener && !isSupport(member, panel)) return interaction.reply({ content: "No permission.", ephemeral: true });

  await interaction.reply({ content: "📄 Building transcript…", ephemeral: true });

  const out = await buildTranscript(interaction.channel);
  if (!out) return interaction.followUp({ content: "❌ Failed to build transcript.", ephemeral: true });

  // post to log channel if set
  const logId = panel?.logChannelId;
  if (logId) {
    const logCh = await guild.channels.fetch(logId).catch(() => null);
    if (logCh && "send" in logCh) {
      await logCh
        .send({
          content: `📄 Transcript for <#${interaction.channelId}> (Ticket ID: ${ticket.id})`,
          files: [{ attachment: out.outPath, name: out.fileName }],
        })
        .catch(() => {});
    }
  }

  await interaction.followUp({ content: "✅ Transcript generated (sent to logs if configured).", ephemeral: true });
}

/* ===================== STAFF SEEN INDICATOR + SILENT ESCALATION ===================== */

async function onMessageCreate(message) {
  if (!message.guild || message.author?.bot) return;
  const tickets = getGuildTickets(message.guild.id);
  const ticket = tickets[message.channelId];
  if (!ticket) return;

  const panels = getGuildPanels(message.guild.id);
  const panel = panels[ticket.panelChannelId];
  if (!panel) return;

  // Track last user message time (for SLA timers later)
  if (message.author.id === ticket.createdBy) {
    ticket.lastUserMsgAt = Date.now();
    tickets[message.channelId] = ticket;
    persist();
    return;
  }

  // Staff seen indicator
  const member = await message.guild.members.fetch(message.author.id).catch(() => null);
  if (isSupport(member, panel)) {
    ticket.lastStaffSeenAt = Date.now();
    tickets[message.channelId] = ticket;
    persist();
  }
}

/* ===================== INIT ===================== */

function initTicketSystem(client, commandsArray, SlashCommandBuilder) {
  // Add slash command definition to bot.js command list
  commandsArray.push(buildTicketPanelCommand(SlashCommandBuilder).toJSON());

  // Interaction handler
  client.on("interactionCreate", async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        if (interaction.commandName === "ticketpanel") {
          return handleTicketPanel(interaction);
        }
      }

      if (interaction.isButton()) {
        const id = interaction.customId;

        // panel creates
        if (id.startsWith("ticket:create:")) {
          const typeKey = id.split(":")[2];
          return createTicketFromPanel(interaction, typeKey);
        }

        // ticket actions
        if (id === "ticket:claim") return handleClaim(interaction);
        if (id === "ticket:unclaim") return handleUnclaim(interaction);
        if (id === "ticket:close") return handleClose(interaction);
        if (id === "ticket:reopen") return handleReopen(interaction);
        if (id === "ticket:note") return handleNote(interaction);
        if (id === "ticket:transcript") return handleTranscript(interaction);

        if (id.startsWith("ticket:rate:")) {
          const score = parseInt(id.split(":")[2], 10);
          if (![1, 2, 3, 4, 5].includes(score)) return;
          return handleRate(interaction, score);
        }
      }

      if (interaction.isModalSubmit()) {
        if (interaction.customId === "ticket:close:modal") return handleCloseModal(interaction);
        if (interaction.customId === "ticket:note:modal") return handleNoteModal(interaction);
      }
    } catch (e) {
      console.error("ticket interaction error:", e?.message || e);
      try {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: "❌ Ticket system error (check logs).", ephemeral: true });
        }
      } catch {}
    }
  });

  client.on("messageCreate", onMessageCreate);
}

module.exports = { initTicketSystem };
