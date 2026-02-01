"use strict";

/**
 * Spirals 3X Ticket System
 * - Panel in a channel (buttons)
 * - Private ticket channels (not threads)
 * - Multiple support roles per panel
 * - Ticket states + assign/close/reopen/transcript
 * - Logs + staff metrics + SLA escalation (simple)
 */

const fs = require("fs");
const path = require("path");

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionsBitField,
} = require("discord.js");

// ================== BRAND / COLOURS ==================
const BRAND = process.env.TICKET_BRAND || "🌀 SPIRALS 3X";
const COLOR_PRIMARY = 0x2efcff; // neon cyan-ish
const COLOR_ACCENT = 0xa855f7; // neon purple-ish
const COLOR_DARK = 0x0b1020;

const FOOTER = process.env.UI_FOOTER || "🌀 SPIRALS 3X • Support";

// ================== ENV ==================
const TICKET_LOG_CHANNEL_ID = process.env.TICKET_LOG_CHANNEL_ID || ""; // optional
const TICKET_SLA_MINUTES = Math.max(1, parseInt(process.env.TICKET_SLA_MINUTES || "20", 10) || 20);
const TICKET_ESCALATE_ROLE_ID = process.env.TICKET_ESCALATE_ROLE_ID || ""; // optional
const TICKET_COOLDOWN_SECONDS = Math.max(30, parseInt(process.env.TICKET_COOLDOWN_SECONDS || "120", 10) || 120);

// ================== DATA ==================
const DATA_DIR = path.join(__dirname, "data");
const TICKETS_FILE = path.join(DATA_DIR, "tickets.json");
const METRICS_FILE = path.join(DATA_DIR, "ticket_metrics.json");

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

const db = loadJsonSafe(TICKETS_FILE, {
  nextId: 1,
  panels: {}, // panelMessageId -> panel config
  tickets: {}, // ticketId -> ticket object
  userCooldown: {}, // userId -> lastCreatedAt (unix sec)
});

const metrics = loadJsonSafe(METRICS_FILE, {
  staff: {}, // staffId -> { assigned: 0, closed: 0, totalCloseSeconds: 0 }
});

function saveDb() {
  saveJson(TICKETS_FILE, db);
}
function saveMetrics() {
  saveJson(METRICS_FILE, metrics);
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function tagUser(id) {
  return `<@${id}>`;
}
function tagRole(id) {
  return `<@&${id}>`;
}

function isSupportMember(member, supportRoleIds = []) {
  if (!member) return false;
  return supportRoleIds.some((rid) => member.roles?.cache?.has(rid));
}

function makePanelKey(guildId, channelId, messageId) {
  return `${guildId}:${channelId}:${messageId}`;
}

// ================== COMMANDS ==================
const ticketCommands = [
  new SlashCommandBuilder()
    .setName("ticketpanel")
    .setDescription("Create a Spirals 3X support panel in a channel")
    .addSubcommand((sc) =>
      sc
        .setName("create")
        .setDescription("Create a ticket panel (buttons) in a channel")
        .addChannelOption((o) =>
          o
            .setName("channel")
            .setDescription("Where the panel message should be posted")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
        )
        .addChannelOption((o) =>
          o
            .setName("category")
            .setDescription("Category to create ticket channels under")
            .addChannelTypes(ChannelType.GuildCategory)
            .setRequired(true)
        )
        .addRoleOption((o) => o.setName("support_role_1").setDescription("Support role #1").setRequired(true))
        .addRoleOption((o) => o.setName("support_role_2").setDescription("Support role #2 (optional)").setRequired(false))
        .addRoleOption((o) => o.setName("support_role_3").setDescription("Support role #3 (optional)").setRequired(false))
        .addStringOption((o) =>
          o
            .setName("title")
            .setDescription("Panel title (optional)")
            .setRequired(false)
        )
        .addStringOption((o) =>
          o
            .setName("description")
            .setDescription("Panel description (optional)")
            .setRequired(false)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("metrics")
        .setDescription("View staff ticket metrics (support roles only)")
    ),
].map((c) => c.toJSON());

// ================== PANEL UI ==================
function panelEmbed(title, description) {
  return new EmbedBuilder()
    .setColor(COLOR_ACCENT)
    .setTitle(title || `🎟️ ${BRAND} Support`)
    .setDescription(
      (description ? `${description}\n\n` : "") +
        `Choose what you need help with below. A private channel will be created for you and staff.\n\n` +
        `🛒 **Shop Issues** — payments, missing items, store problems\n` +
        `🚩 **Report a Player** — cheating, harassment, scams\n` +
        `🧩 **General Support** — anything else\n`
    )
    .setFooter({ text: FOOTER });
}

function panelButtons(panelKey) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket_open:${panelKey}:shop`).setLabel("Shop Issues").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`ticket_open:${panelKey}:report`).setLabel("Report a Player").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`ticket_open:${panelKey}:general`).setLabel("General Support").setStyle(ButtonStyle.Secondary)
  );
}

// ================== TICKET UI ==================
function ticketStateLabel(state) {
  if (state === "OPEN") return "🟢 Open";
  if (state === "ASSIGNED") return "🟣 Assigned";
  if (state === "WAITING") return "🟡 Waiting on Player";
  if (state === "ESCALATED") return "🔴 Escalated";
  if (state === "CLOSED") return "⚫ Closed";
  return state;
}

function ticketTopicLabel(topic) {
  if (topic === "shop") return "🛒 Shop Issues";
  if (topic === "report") return "🚩 Report a Player";
  return "🧩 General Support";
}

function ticketControlsRow(ticketId, state) {
  const row = new ActionRowBuilder();

  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`ticket_assign:${ticketId}`)
      .setLabel("Assign")
      .setStyle(ButtonStyle.Secondary)
  );

  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`ticket_seen:${ticketId}`)
      .setLabel("Staff Seen")
      .setStyle(ButtonStyle.Secondary)
  );

  if (state !== "CLOSED") {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`ticket_close:${ticketId}`)
        .setLabel("Close")
        .setStyle(ButtonStyle.Danger)
    );
  } else {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`ticket_reopen:${ticketId}`)
        .setLabel("Reopen")
        .setStyle(ButtonStyle.Primary)
    );
  }

  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`ticket_transcript:${ticketId}`)
      .setLabel("Transcript")
      .setStyle(ButtonStyle.Secondary)
  );

  return row;
}

function ratingRow(ticketId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket_rate:${ticketId}:1`).setLabel("1").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`ticket_rate:${ticketId}:2`).setLabel("2").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`ticket_rate:${ticketId}:3`).setLabel("3").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`ticket_rate:${ticketId}:4`).setLabel("4").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`ticket_rate:${ticketId}:5`).setLabel("5").setStyle(ButtonStyle.Primary)
  );
}

function ticketEmbed(t) {
  const assigned = t.assignedTo ? tagUser(t.assignedTo) : "`Unassigned`";
  const seen = t.lastStaffSeenAt ? `<t:${t.lastStaffSeenAt}:R>` : "`Not yet`";
  const created = `<t:${t.createdAt}:F>`;

  return new EmbedBuilder()
    .setColor(t.state === "CLOSED" ? COLOR_DARK : COLOR_PRIMARY)
    .setTitle(`🎟️ Ticket #${t.id} • ${ticketStateLabel(t.state)}`)
    .setDescription(
      `**Player:** ${tagUser(t.userId)}\n` +
        `**Topic:** ${ticketTopicLabel(t.topic)}\n` +
        `**Assigned:** ${assigned}\n` +
        `**Created:** ${created}\n` +
        `**Staff Seen:** ${seen}\n` +
        (t.rating ? `\n⭐ **Rating:** **${t.rating}/5**` : "")
    )
    .setFooter({ text: FOOTER });
}

async function sendLog(guild, embed, content = "") {
  if (!TICKET_LOG_CHANNEL_ID) return;
  const ch = await guild.channels.fetch(TICKET_LOG_CHANNEL_ID).catch(() => null);
  if (!ch || !("send" in ch)) return;
  await ch.send({ content: content || undefined, embeds: [embed] }).catch(() => {});
}

// ================== CREATE TICKET ==================
async function createTicketFromPanel(interaction, panel, topic) {
  const userId = interaction.user.id;
  const guild = interaction.guild;

  // cooldown
  const last = db.userCooldown[userId] || 0;
  const left = last + TICKET_COOLDOWN_SECONDS - nowSec();
  if (left > 0) {
    return interaction.reply({
      content: `⏳ Please wait <t:${nowSec() + left}:R> before opening another ticket.`,
      ephemeral: true,
    });
  }

  const id = db.nextId++;
  const name = `ticket-${id}`;
  const categoryId = panel.categoryId;

  const supportRoleIds = panel.supportRoleIds || [];

  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
    { id: userId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles] },
    { id: guild.members.me.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.ManageMessages] },
    ...supportRoleIds.map((rid) => ({
      id: rid,
      allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles],
    })),
  ];

  const channel = await guild.channels
    .create({
      name,
      type: ChannelType.GuildText,
      parent: categoryId,
      permissionOverwrites: overwrites,
      topic: `Spirals3X Ticket #${id} • ${userId} • ${topic}`,
    })
    .catch(() => null);

  if (!channel) {
    return interaction.reply({ content: "❌ Couldn't create the ticket channel (check bot permissions).", ephemeral: true });
  }

  const t = {
    id,
    guildId: guild.id,
    channelId: channel.id,
    userId,
    topic,
    panelKey: panel.panelKey,
    state: "OPEN",
    assignedTo: null,
    createdAt: nowSec(),
    closedAt: null,
    lastStaffSeenAt: 0,
    escalatedAt: 0,
    rating: 0,
  };

  db.tickets[String(id)] = t;
  db.userCooldown[userId] = nowSec();
  saveDb();

  const pingRoles = supportRoleIds.length ? supportRoleIds.map(tagRole).join(" ") : "";
  await channel.send({
    content: `${tagUser(userId)} ticket created. ${pingRoles}`.trim(),
    embeds: [ticketEmbed(t)],
    components: [ticketControlsRow(String(id), t.state)],
  });

  await sendLog(
    guild,
    new EmbedBuilder()
      .setColor(COLOR_PRIMARY)
      .setTitle(`🎟️ Ticket Created • #${id}`)
      .setDescription(`Channel: <#${channel.id}>\nPlayer: ${tagUser(userId)}\nTopic: ${ticketTopicLabel(topic)}`)
      .setFooter({ text: FOOTER })
  );

  return interaction.reply({ content: `✅ Ticket created: <#${channel.id}>`, ephemeral: true });
}

// ================== TRANSCRIPT ==================
async function buildTranscript(channel) {
  // Fetch up to 100 most recent (good enough for v1)
  const msgs = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (!msgs) return { text: "Transcript fetch failed.", fileName: "transcript.txt" };

  const arr = Array.from(msgs.values()).sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  const lines = arr.map((m) => {
    const ts = new Date(m.createdTimestamp).toISOString();
    const author = `${m.author?.tag || "Unknown"} (${m.author?.id || "?"})`;
    const content = (m.content || "").replace(/\n/g, " ");
    const atts = m.attachments?.size ? ` [attachments: ${m.attachments.map((a) => a.url).join(" ")}]` : "";
    return `[${ts}] ${author}: ${content}${atts}`;
  });

  return {
    text: lines.join("\n").slice(0, 190000), // Discord file size/text safety
    fileName: `ticket-transcript-${channel.id}.txt`,
  };
}

// ================== SLA ESCALATION (simple) ==================
async function slaSweep(client) {
  const now = nowSec();
  const slaSec = TICKET_SLA_MINUTES * 60;

  for (const t of Object.values(db.tickets)) {
    if (!t || t.state === "CLOSED") continue;

    // If staff hasn't seen it within SLA
    if (!t.lastStaffSeenAt && now - t.createdAt >= slaSec && !t.escalatedAt) {
      t.state = "ESCALATED";
      t.escalatedAt = now;

      const guild = await client.guilds.fetch(t.guildId).catch(() => null);
      if (!guild) continue;

      const ch = await guild.channels.fetch(t.channelId).catch(() => null);
      if (ch && "send" in ch) {
        const ping = TICKET_ESCALATE_ROLE_ID ? `\n${tagRole(TICKET_ESCALATE_ROLE_ID)} (silent escalation)` : "";
        await ch.send({
          content: `🔴 This ticket hit SLA without a staff response.${ping}`,
          embeds: [ticketEmbed(t)],
          components: [ticketControlsRow(String(t.id), t.state)],
        }).catch(() => {});
      }

      await sendLog(
        guild,
        new EmbedBuilder()
          .setColor(COLOR_DARK)
          .setTitle(`🔴 SLA Escalation • Ticket #${t.id}`)
          .setDescription(`Channel: <#${t.channelId}>\nPlayer: ${tagUser(t.userId)}`)
          .setFooter({ text: FOOTER })
      );

      saveDb();
    }
  }
}

// ================== INTERACTION HANDLERS ==================
async function handlePanelCreate(interaction) {
  const channel = interaction.options.getChannel("channel", true);
  const category = interaction.options.getChannel("category", true);
  const r1 = interaction.options.getRole("support_role_1", true);
  const r2 = interaction.options.getRole("support_role_2", false);
  const r3 = interaction.options.getRole("support_role_3", false);

  const title = interaction.options.getString("title", false);
  const description = interaction.options.getString("description", false);

  const supportRoleIds = [r1?.id, r2?.id, r3?.id].filter(Boolean);

  // Send panel message
  const panelMsg = await channel
    .send({
      embeds: [panelEmbed(title, description)],
    })
    .catch(() => null);

  if (!panelMsg) {
    return interaction.reply({ content: "❌ Couldn't post panel message. Check permissions.", ephemeral: true });
  }

  const panelKey = makePanelKey(interaction.guildId, channel.id, panelMsg.id);

  // Edit panel with buttons (needs panelKey)
  await panelMsg.edit({ components: [panelButtons(panelKey)] }).catch(() => {});

  // Store panel config
  db.panels[panelKey] = {
    panelKey,
    guildId: interaction.guildId,
    channelId: channel.id,
    messageId: panelMsg.id,
    categoryId: category.id,
    supportRoleIds,
    createdAt: nowSec(),
  };
  saveDb();

  await interaction.reply({ content: `✅ Panel created in <#${channel.id}>.`, ephemeral: true });
}

async function handleMetrics(interaction) {
  // Only allow if user has ANY support role from ANY panel in guild
  const member = interaction.member;
  const guildPanels = Object.values(db.panels).filter((p) => p.guildId === interaction.guildId);

  const allowed = guildPanels.some((p) => isSupportMember(member, p.supportRoleIds));
  if (!allowed) return interaction.reply({ content: "❌ Support only.", ephemeral: true });

  const arr = Object.entries(metrics.staff).map(([id, m]) => ({
    id,
    assigned: m.assigned || 0,
    closed: m.closed || 0,
    avgCloseMin: m.closed ? Math.round((m.totalCloseSeconds / m.closed) / 60) : 0,
  }));

  arr.sort((a, b) => b.closed - a.closed);

  const lines = arr.slice(0, 15).map((x, i) => {
    return `**${i + 1}.** ${tagUser(x.id)} — closed **${x.closed}**, assigned **${x.assigned}**, avg close **${x.avgCloseMin}m**`;
  });

  return interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(COLOR_ACCENT)
        .setTitle(`📈 ${BRAND} • Staff Ticket Metrics`)
        .setDescription(lines.length ? lines.join("\n") : "`No metrics yet.`")
        .setFooter({ text: FOOTER }),
    ],
    ephemeral: true,
  });
}

async function handleButton(interaction) {
  const id = interaction.customId;

  // Open ticket from panel
  if (id.startsWith("ticket_open:")) {
    const [, panelKey, topic] = id.split(":");
    const panel = db.panels[panelKey];
    if (!panel) return interaction.reply({ content: "❌ Panel not found (it may have been deleted).", ephemeral: true });
    return createTicketFromPanel(interaction, panel, topic);
  }

  // ticket actions
  const parts = id.split(":");
  const action = parts[0];
  const ticketId = parts[1];
  const t = db.tickets[String(ticketId)];

  if (!t) return interaction.reply({ content: "❌ Ticket not found.", ephemeral: true });

  const guild = interaction.guild;
  const channel = await guild.channels.fetch(t.channelId).catch(() => null);
  if (!channel) return interaction.reply({ content: "❌ Ticket channel not found.", ephemeral: true });

  // Determine support roles (from panel)
  const panel = db.panels[t.panelKey] || null;
  const supportRoleIds = panel?.supportRoleIds || [];
  const member = interaction.member;
  const isSupport = isSupportMember(member, supportRoleIds);

  // Assign
  if (action === "ticket_assign") {
    if (!isSupport) return interaction.reply({ content: "❌ Support only.", ephemeral: true });

    t.assignedTo = interaction.user.id;
    t.state = "ASSIGNED";

    metrics.staff[t.assignedTo] = metrics.staff[t.assignedTo] || { assigned: 0, closed: 0, totalCloseSeconds: 0 };
    metrics.staff[t.assignedTo].assigned += 1;
    saveMetrics();
    saveDb();

    await interaction.reply({ content: `✅ Assigned to ${tagUser(t.assignedTo)}.`, ephemeral: true });
    await channel.send({ embeds: [ticketEmbed(t)], components: [ticketControlsRow(String(t.id), t.state)] }).catch(() => {});
    return;
  }

  // Staff Seen
  if (action === "ticket_seen") {
    if (!isSupport) return interaction.reply({ content: "❌ Support only.", ephemeral: true });
    t.lastStaffSeenAt = nowSec();
    if (t.state === "OPEN") t.state = "WAITING";
    saveDb();

    await interaction.reply({ content: "✅ Marked as seen.", ephemeral: true });
    await channel.send({ embeds: [ticketEmbed(t)], components: [ticketControlsRow(String(t.id), t.state)] }).catch(() => {});
    return;
  }

  // Close
  if (action === "ticket_close") {
    if (!isSupport) return interaction.reply({ content: "❌ Support only.", ephemeral: true });

    t.state = "CLOSED";
    t.closedAt = nowSec();
    saveDb();

    // lock channel (player can read but not send)
    await channel.permissionOverwrites
      .edit(t.userId, { SendMessages: false, AttachFiles: false })
      .catch(() => {});

    // metrics close time (if assigned)
    const closerId = interaction.user.id;
    metrics.staff[closerId] = metrics.staff[closerId] || { assigned: 0, closed: 0, totalCloseSeconds: 0 };
    metrics.staff[closerId].closed += 1;
    metrics.staff[closerId].totalCloseSeconds += Math.max(0, (t.closedAt || nowSec()) - t.createdAt);
    saveMetrics();

    await interaction.reply({ content: "✅ Ticket closed.", ephemeral: true });

    await channel
      .send({
        content: `⚫ Ticket closed by ${tagUser(closerId)}.\nPlease rate support (1–5):`,
        embeds: [ticketEmbed(t)],
        components: [ticketControlsRow(String(t.id), t.state), ratingRow(String(t.id))],
      })
      .catch(() => {});

    await sendLog(
      guild,
      new EmbedBuilder()
        .setColor(COLOR_DARK)
        .setTitle(`⚫ Ticket Closed • #${t.id}`)
        .setDescription(`Channel: <#${t.channelId}>\nPlayer: ${tagUser(t.userId)}\nClosed by: ${tagUser(closerId)}`)
        .setFooter({ text: FOOTER })
    );

    return;
  }

  // Reopen
  if (action === "ticket_reopen") {
    if (!isSupport) return interaction.reply({ content: "❌ Support only.", ephemeral: true });

    t.state = "OPEN";
    t.closedAt = 0;
    saveDb();

    await channel.permissionOverwrites
      .edit(t.userId, { SendMessages: true, AttachFiles: true })
      .catch(() => {});

    await interaction.reply({ content: "✅ Ticket reopened.", ephemeral: true });
    await channel.send({ embeds: [ticketEmbed(t)], components: [ticketControlsRow(String(t.id), t.state)] }).catch(() => {});
    return;
  }

  // Transcript
  if (action === "ticket_transcript") {
    if (!isSupport) return interaction.reply({ content: "❌ Support only.", ephemeral: true });

    await interaction.reply({ content: "📄 Building transcript…", ephemeral: true });

    const tx = await buildTranscript(channel);
    const buf = Buffer.from(tx.text, "utf8");

    await sendLog(
      guild,
      new EmbedBuilder()
        .setColor(COLOR_ACCENT)
        .setTitle(`📄 Transcript • Ticket #${t.id}`)
        .setDescription(`Channel: <#${t.channelId}>\nRequested by: ${tagUser(interaction.user.id)}`)
        .setFooter({ text: FOOTER })
    );

    // Also send transcript file into log channel if set, else into ticket channel
    const target =
      (TICKET_LOG_CHANNEL_ID && (await guild.channels.fetch(TICKET_LOG_CHANNEL_ID).catch(() => null))) || channel;

    if (target && "send" in target) {
      await target.send({
        content: `📄 Transcript for Ticket #${t.id}`,
        files: [{ attachment: buf, name: tx.fileName }],
      }).catch(() => {});
    }

    return;
  }

  // Rating
  if (action === "ticket_rate") {
    // ticket_rate:<ticketId>:<n>
    const rating = parseInt(parts[2] || "0", 10);
    if (!rating || rating < 1 || rating > 5) return interaction.reply({ content: "❌ Invalid rating.", ephemeral: true });

    // allow ONLY ticket owner to rate
    if (interaction.user.id !== t.userId) {
      return interaction.reply({ content: "❌ Only the ticket owner can rate.", ephemeral: true });
    }

    t.rating = rating;
    saveDb();

    await interaction.reply({ content: `⭐ Thanks! You rated support **${rating}/5**.`, ephemeral: true });
    await channel.send({ embeds: [ticketEmbed(t)] }).catch(() => {});
    return;
  }
}

// ================== INIT ==================
function initTicketSystem(client) {
  // Expose commands list to main bot
  client.__ticketCommands = ticketCommands;

  // SLA sweep every 60s
  setInterval(() => {
    slaSweep(client).catch(() => {});
  }, 60_000);

  client.on("interactionCreate", async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        if (interaction.commandName !== "ticketpanel") return;

        const sub = interaction.options.getSubcommand();

        // Admin only for create
        if (sub === "create") {
          const isAdmin = interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);
          if (!isAdmin) return interaction.reply({ content: "❌ Admin only.", ephemeral: true });
          return handlePanelCreate(interaction);
        }

        if (sub === "metrics") {
          return handleMetrics(interaction);
        }
      }

      if (interaction.isButton()) {
        if (!interaction.customId.startsWith("ticket_")) return;
        return handleButton(interaction);
      }
    } catch (e) {
      console.log("tickets interaction error:", e?.message || e);
      if (!interaction.replied) {
        try {
          await interaction.reply({ content: "❌ Ticket system error (check logs).", ephemeral: true });
        } catch {}
      }
    }
  });
}

module.exports = { initTicketSystem, ticketCommands };
