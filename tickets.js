"use strict";

const fs = require("fs");
const path = require("path");
const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  ChannelType,
  PermissionsBitField,
} = require("discord.js");

function envList(name) {
  const raw = (process.env[name] || "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function safeNowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(
    d.getMinutes()
  )}-${pad(d.getSeconds())}`;
}

function makeTicketPanelEmbed() {
  const brand = process.env.UI_FOOTER || "🌀 SPIRALS 3X";
  return new EmbedBuilder()
    .setTitle("🎟️ Open a Ticket")
    .setDescription(
      [
        "Press the button below to open a support ticket.",
        "",
        "✅ You’ll be asked for a short reason.",
        "🔒 A private channel will be created for you + staff.",
      ].join("\n")
    )
    .setFooter({ text: brand });
}

function makePanelRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("ticket_open").setLabel("Open Ticket").setStyle(ButtonStyle.Primary)
  );
}

function makeCloseRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("ticket_close").setLabel("Close Ticket").setStyle(ButtonStyle.Danger)
  );
}

function buildReasonModal() {
  return new ModalBuilder()
    .setCustomId("ticket_reason_modal")
    .setTitle("Open Ticket")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("ticket_reason")
          .setLabel("What do you need help with?")
          .setStyle(TextInputStyle.Paragraph)
          .setMinLength(3)
          .setMaxLength(600)
          .setRequired(true)
      )
    );
}
async function postLog(guild, content, embeds) {
  const logChannelId = (process.env.TICKET_LOG_CHANNEL_ID || "").trim();
  if (!logChannelId) return;

  const ch = await guild.channels.fetch(logChannelId).catch(() => null);
  if (!ch || !("send" in ch)) return;

  await ch
    .send({
      content: content || undefined,
      embeds: embeds && embeds.length ? embeds : undefined,
      allowedMentions: { parse: [] },
    })
    .catch(() => {});
}

function createTicketCommands() {
  const cmd = new SlashCommandBuilder()
    .setName("ticketpanel")
    .setDescription("Post the ticket panel (admin).")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator);

  return [cmd];
}

async function handleTicketPanelCommand(interaction) {
  const onlyChannel = (process.env.TICKET_PANEL_CHANNEL_ID || "").trim();
  if (onlyChannel && interaction.channelId !== onlyChannel) {
    return interaction.reply({
      content: `❌ You can only use this in <#${onlyChannel}>.`,
      ephemeral: true,
    });
  }

  await interaction.reply({
    embeds: [makeTicketPanelEmbed()],
    components: [makePanelRow()],
  });
}

async function createTicketChannel(guild, openerUser, reason) {
  const categoryId = (process.env.TICKET_CATEGORY_ID || "").trim();
  const supportRoleIds = envList("TICKET_SUPPORT_ROLE_IDS");
  const prefix = (process.env.TICKET_CHANNEL_PREFIX || "ticket").trim() || "ticket";

  if (!categoryId) {
    return {
      ok: false,
      error:
        "TICKET_CATEGORY_ID is missing in .env. Add it (Discord category ID where ticket channels should be created).",
    };
  }

  const category = await guild.channels.fetch(categoryId).catch(() => null);
  if (!category || category.type !== ChannelType.GuildCategory) {
    return { ok: false, error: "TICKET_CATEGORY_ID does not point to a valid Category channel." };
  }

  const safeName = `${prefix}-${openerUser.username}`.toLowerCase().replace(/[^a-z0-9-_]/g, "");
  const name = safeName.length > 90 ? safeName.slice(0, 90) : safeName;

  const overwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionsBitField.Flags.ViewChannel],
    },
    {
      id: openerUser.id,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory,
        PermissionsBitField.Flags.AttachFiles,
        PermissionsBitField.Flags.EmbedLinks,
      ],
    },
  ];

  for (const rid of supportRoleIds) {
    overwrites.push({
      id: rid,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory,
        PermissionsBitField.Flags.ManageMessages,
        PermissionsBitField.Flags.AttachFiles,
        PermissionsBitField.Flags.EmbedLinks,
      ],
    });
  }

  const channel = await guild.channels
    .create({
      name,
      type: ChannelType.GuildText,
      parent: categoryId,
      permissionOverwrites: overwrites,
      topic: `Ticket for ${openerUser.tag} (${openerUser.id}) • Reason: ${String(reason).slice(0, 200)}`,
    })
    .catch((e) => null);

  if (!channel) return { ok: false, error: "Failed to create ticket channel (missing permissions?)." };

  return { ok: true, channel };
}
async function writeTranscript(channel) {
  const dataDir = path.join(__dirname, "data", "tickets");
  ensureDir(dataDir);

  const stamp = safeNowStamp();
  const file = path.join(dataDir, `${channel.id}_${stamp}.txt`);

  const msgs = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  const arr = msgs ? Array.from(msgs.values()).reverse() : [];

  const lines = [];
  lines.push(`Transcript for #${channel.name} (${channel.id})`);
  lines.push(`Created: ${new Date(channel.createdTimestamp).toISOString()}`);
  lines.push(`Saved: ${new Date().toISOString()}`);
  lines.push("--------------------------------------------------");

  for (const m of arr) {
    const when = new Date(m.createdTimestamp).toISOString();
    const author = `${m.author?.tag || "Unknown"} (${m.author?.id || "?"})`;
    const content = m.content || "";
    lines.push(`[${when}] ${author}: ${content}`);
  }

  fs.writeFileSync(file, lines.join("\n"), "utf8");
  return file;
}

function createTicketSystem() {
  const commands = createTicketCommands();

  async function handleInteraction(interaction) {
    try {
      // /ticketpanel (slash)
      if (interaction.isChatInputCommand() && interaction.commandName === "ticketpanel") {
        return (await handleTicketPanelCommand(interaction)), true;
      }

      // Button: Open ticket
      if (interaction.isButton() && interaction.customId === "ticket_open") {
        const missingCategory = !(process.env.TICKET_CATEGORY_ID || "").trim();
        if (missingCategory) {
          await interaction.reply({
            content:
              "❌ Tickets aren’t configured yet.\nAdd `TICKET_CATEGORY_ID` (and optionally `TICKET_SUPPORT_ROLE_IDS`, `TICKET_LOG_CHANNEL_ID`) to your `.env`.",
            ephemeral: true,
          });
          return true;
        }

        await interaction.showModal(buildReasonModal());
        return true;
      }

      // Modal submit: reason
      if (interaction.isModalSubmit() && interaction.customId === "ticket_reason_modal") {
        const reason = interaction.fields.getTextInputValue("ticket_reason");
        const guild = interaction.guild;
        if (!guild) {
          await interaction.reply({ content: "❌ This can only be used in a server.", ephemeral: true });
          return true;
        }

        await interaction.reply({ content: "✅ Creating your ticket…", ephemeral: true });

        const created = await createTicketChannel(guild, interaction.user, reason);
        if (!created.ok) {
          await interaction.followUp({ content: `❌ ${created.error}`, ephemeral: true });
          return true;
        }

        const ch = created.channel;

        const openEmbed = new EmbedBuilder()
          .setTitle("🎟️ Ticket Opened")
          .setDescription(
            `Hello ${interaction.user}, staff will be with you soon.\n\n**Reason:**\n${String(reason).slice(0, 1500)}`
          )
          .setFooter({ text: process.env.UI_FOOTER || "🌀 SPIRALS 3X" });

        await ch.send({ content: `${interaction.user}`, embeds: [openEmbed], components: [makeCloseRow()] }).catch(() => {});
        await interaction.followUp({ content: `✅ Ticket created: <#${ch.id}>`, ephemeral: true }).catch(() => {});

        await postLog(
          guild,
          `🎟️ Ticket opened by ${interaction.user.tag} (${interaction.user.id}) → <#${ch.id}>`,
          []
        );

        return true;
      }

      // Button: Close ticket
      if (interaction.isButton() && interaction.customId === "ticket_close") {
        const ch = interaction.channel;
        const guild = interaction.guild;
        if (!ch || !guild) return false;

        await interaction.reply({ content: "🧹 Closing ticket…", ephemeral: true }).catch(() => {});

        let transcriptPath = null;
        const wantTranscript = (process.env.TICKET_LOG_CHANNEL_ID || "").trim();
        if (wantTranscript) {
          transcriptPath = await writeTranscript(ch).catch(() => null);
        }

        await postLog(
          guild,
          `🧹 Ticket closed in <#${ch.id}> by ${interaction.user.tag} (${interaction.user.id})` +
            (transcriptPath ? `\n📝 Transcript saved on server: \`${transcriptPath}\`` : ""),
          []
        );

        // Delete after short delay to let messages send
        setTimeout(() => {
          ch.delete("Ticket closed").catch(() => {});
        }, 1500);

        return true;
      }

      return false;
    } catch (e) {
      console.error("Ticket system error:", e?.message || e);
      try {
        if (interaction && !interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: "❌ Ticket system error (check logs).", ephemeral: true });
        }
      } catch {}
      return true;
    }
  }

  return { commands, handleInteraction };
}

module.exports = { createTicketSystem };
