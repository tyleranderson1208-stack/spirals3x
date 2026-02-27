"use strict";

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

const DEFAULT_PANEL_CHANNEL_ID = process.env.SIGNAL_ROLES_CHANNEL_ID || "1465517573108928628";

const SIGNALS = [
  {
    key: "giveaways",
    label: "Giveaways",
    emoji: "🎁",
    roleId: process.env.SIGNAL_ROLE_GIVEAWAYS || "1477073449259106528",
    desc: "Live drops and winner posts.",
  },
  {
    key: "polls",
    label: "Polls",
    emoji: "🗳️",
    roleId: process.env.SIGNAL_ROLE_POLLS || "1477073705606840451",
    desc: "Vote launches and outcomes.",
  },
  {
    key: "suggestions",
    label: "Suggestions",
    emoji: "💡",
    roleId: process.env.SIGNAL_ROLE_SUGGESTIONS || "1477073787240583289",
    desc: "Community ideas and decisions.",
  },
  {
    key: "events",
    label: "Events",
    emoji: "📅",
    roleId: process.env.SIGNAL_ROLE_EVENTS || "1477073813739933847",
    desc: "Scheduled events and reminders.",
  },
  {
    key: "raid",
    label: "Raid Alerts",
    emoji: "🚨",
    roleId: process.env.SIGNAL_ROLE_RAID || "1477073911572070583",
    desc: "Critical raid-related pings.",
  },
  {
    key: "nuke",
    label: "Nuke Alerts",
    emoji: "☢️",
    roleId: process.env.SIGNAL_ROLE_NUKE || "1477073963694686281",
    desc: "Nuke notifications and timing.",
  },
];

function isAdmin(interaction) {
  return interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);
}

function signalRows() {
  const row1 = new ActionRowBuilder();
  const row2 = new ActionRowBuilder();

  SIGNALS.slice(0, 3).forEach((s) => {
    row1.addComponents(
      new ButtonBuilder().setCustomId(`sig:${s.key}`).setLabel(s.label).setEmoji(s.emoji).setStyle(ButtonStyle.Primary)
    );
  });

  SIGNALS.slice(3, 6).forEach((s) => {
    row2.addComponents(
      new ButtonBuilder().setCustomId(`sig:${s.key}`).setLabel(s.label).setEmoji(s.emoji).setStyle(ButtonStyle.Primary)
    );
  });

  return [row1, row2];
}

function signalEmbed() {
  const lines = [
    `🎁 <@&${SIGNALS[0].roleId}> — Giveaway drops and winner calls.`,
    `🗳️ <@&${SIGNALS[1].roleId}> — Poll opens, closes, and outcomes.`,
    `💡 <@&${SIGNALS[2].roleId}> — Suggestion updates and staff decisions.`,
    `📅 <@&${SIGNALS[3].roleId}> — Event announcements and reminders.`,
    `🚨 <@&${SIGNALS[4].roleId}> — Alerts when your team is being raided in-game.`,
    `☢️ <@&${SIGNALS[5].roleId}> — Nuke drop alerts so you can claim point rewards.`,
  ].join("\n");
  return new EmbedBuilder()
    .setColor(COLOR_PRIMARY)
    .setTitle(`🛰️ ${BRAND} — SIGNAL HUB`)
    .setDescription(
      [
        "The Spiral whispers only to those tuned in.",
        "",
        "Touch a signal below to bind it to your role profile.",
        "",
        lines,
      ].join("\n")
    )
    .setFooter({ text: "Spiral Signal Matrix • Tune in or tune out anytime" })
    .setTimestamp();
}

function createSignalRolesSystem(client, commandsDef = []) {
  const commands = [
    new SlashCommandBuilder()
      .setName("signals-panel")
      .setDescription("Post the SPIRALS signal roles panel (admin)")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addChannelOption((o) => o.setName("channel").setDescription("Where to post the signal panel").setRequired(false)),
  ];

  if (Array.isArray(commandsDef)) commandsDef.push(...commands);

  async function handleInteraction(interaction) {
    if (interaction.isButton() && interaction.customId?.startsWith("sig:")) {
      const key = interaction.customId.split(":")[1] || "";
      const signal = SIGNALS.find((s) => s.key === key);
      if (!signal) {
        await interaction.reply({ content: "❌ Unknown signal role.", ephemeral: true }).catch(() => {});
        return true;
      }

      const guild = interaction.guild;
      const member = interaction.member;
      if (!guild || !member) {
        await interaction.reply({ content: "❌ Server/member context unavailable.", ephemeral: true }).catch(() => {});
        return true;
      }

      const role = await guild.roles.fetch(signal.roleId).catch(() => null);
      if (!role) {
        await interaction.reply({ content: `❌ Role for ${signal.label} is missing.`, ephemeral: true }).catch(() => {});
        return true;
      }

      const has = member.roles?.cache?.has(role.id);
      if (has) {
        await member.roles.remove(role.id).catch(() => {});
        await interaction.reply({ content: `↩️ Removed **${signal.label}** alerts.`, ephemeral: true }).catch(() => {});
      } else {
        await member.roles.add(role.id).catch(() => {});
        await interaction.reply({ content: `✅ Added **${signal.label}** alerts.`, ephemeral: true }).catch(() => {});
      }
      return true;
    }

    if (!interaction.isChatInputCommand() || interaction.commandName !== "signals-panel") return false;

    if (!isAdmin(interaction)) {
      await interaction.reply({ content: "❌ Admin only.", ephemeral: true }).catch(() => {});
      return true;
    }

    const channelOpt = interaction.options.getChannel("channel", false);
    const channelId = channelOpt?.id || DEFAULT_PANEL_CHANNEL_ID;
    const ch = await client.channels.fetch(channelId).catch(() => null);
    if (!ch || !("send" in ch)) {
      await interaction.reply({ content: "❌ Target channel is not accessible.", ephemeral: true }).catch(() => {});
      return true;
    }

    await ch.send({ embeds: [signalEmbed()], components: signalRows() }).catch(() => {});
    await interaction.reply({ content: `✅ Signal panel posted in <#${channelId}>.`, ephemeral: true }).catch(() => {});
    return true;
  }

  return { name: "signalroles", commands, handleInteraction };
}

module.exports = { createSignalRolesSystem };
