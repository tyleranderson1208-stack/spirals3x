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

const BRAND = "STELLAR 3X";
const COLOR_PRIMARY = 0xa84312;
const UI_FOOTER = "Stellar 3X • Signal Locked.";
const SIGNAL_BANNER_URL =
  process.env.SIGNAL_HUB_BANNER_URL ||
  "https://media.discordapp.net/attachments/1468941702801916045/1477090974139416748/3c4cd911-5998-4ab3-9116-276822e0c73b.png?ex=69a37fab&is=69a22e2b&hm=37a719fd1f44227f96d07f8e98302a6041074c96084002bc52de889a62ddf328&=&format=webp&quality=lossless&width=385&height=257";

const DEFAULT_PANEL_CHANNEL_ID = process.env.SIGNAL_ROLES_CHANNEL_ID || "1465517573108928628";

const SIGNALS = [
  { key: "giveaways", label: "Giveaways", emoji: "💫", roleId: process.env.SIGNAL_ROLE_GIVEAWAYS || "1477073449259106528", summary: "Drops and winner calls." },
  { key: "polls", label: "Polls", emoji: "💫", roleId: process.env.SIGNAL_ROLE_POLLS || "1477073705606840451", summary: "Openings, closures, and final outcomes." },
  { key: "suggestions", label: "Suggestions", emoji: "💫", roleId: process.env.SIGNAL_ROLE_SUGGESTIONS || "1477073787240583289", summary: "Community proposals and staff decisions." },
  { key: "events", label: "Events", emoji: "💫", roleId: process.env.SIGNAL_ROLE_EVENTS || "1477073813739933847", summary: "Live events and scheduled reminders." },
  { key: "raid", label: "Raid Alerts", emoji: "💫", roleId: process.env.SIGNAL_ROLE_RAID || "1477073911572070583", summary: "Real-time alerts when your base is under attack." },
  { key: "nuke", label: "Nuke Alerts", emoji: "💫", roleId: process.env.SIGNAL_ROLE_NUKE || "1477073963694686281", summary: "Nuke launches and reward opportunities." },
  { key: "wipe", label: "Wipe Alerts", emoji: "💫", roleId: process.env.SIGNAL_ROLE_WIPE || "", summary: "Map voting, countdowns, and wipe confirmations." },
];

function isAdmin(interaction) {
  return interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);
}

function signalRows() {
  const rowTop = new ActionRowBuilder();
  const rowBottom = new ActionRowBuilder();

  SIGNALS.filter((s) => !["raid", "nuke", "wipe"].includes(s.key)).forEach((s) => {
    rowTop.addComponents(
      new ButtonBuilder().setCustomId(`sig:${s.key}`).setLabel(s.label).setEmoji(s.emoji).setStyle(ButtonStyle.Primary)
    );
  });

  SIGNALS.filter((s) => ["raid", "nuke", "wipe"].includes(s.key)).forEach((s) => {
    rowBottom.addComponents(
      new ButtonBuilder().setCustomId(`sig:${s.key}`).setLabel(s.label).setEmoji(s.emoji).setStyle(ButtonStyle.Primary)
    );
  });

  return [rowTop, rowBottom];
}

function signalEmbed() {
  const roleLine = (s) => `@Stellar • ${s.label}\n↳ ${s.summary}`;

  return new EmbedBuilder()
    .setColor(COLOR_PRIMARY)
    .setTitle(`🛰️ ${BRAND} — SIGNAL HUB`)
    .setDescription(
      [
        "All signals converge here.",
        "Select your channels and lock into the transmissions that matter.",
        "",
        "When the moment comes — you’ll know.",
        "",
        ...SIGNALS.map(roleLine),
      ].join("\n\n")
    )
    .setFooter({ text: UI_FOOTER })
    .setImage(SIGNAL_BANNER_URL)
    .setTimestamp();
}

function createSignalRolesSystem(client, commandsDef = []) {
  const commands = [
    new SlashCommandBuilder()
      .setName("signals-panel")
      .setDescription("Post the STELLAR signal roles panel (admin)")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addChannelOption((o) => o.setName("channel").setDescription("Where to post the signal panel").setRequired(false)),
    new SlashCommandBuilder()
      .setName("signal-panel")
      .setDescription("Post the STELLAR signal roles panel (admin)")
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
      if (!guild) {
        await interaction.reply({ content: "❌ Server context unavailable.", ephemeral: true }).catch(() => {});
        return true;
      }

      if (!signal.roleId) {
        await interaction.reply({ content: `❌ Role for ${signal.label} is not configured.`, ephemeral: true }).catch(() => {});
        return true;
      }

      const member = await guild.members.fetch(interaction.user.id).catch(() => null);
      if (!member) {
        await interaction.reply({ content: "❌ Could not load your member profile.", ephemeral: true }).catch(() => {});
        return true;
      }

      const role = await guild.roles.fetch(signal.roleId).catch(() => null);
      if (!role) {
        await interaction.reply({ content: `❌ Role for ${signal.label} is missing.`, ephemeral: true }).catch(() => {});
        return true;
      }

      const has = member.roles.cache.has(role.id);
      if (has) {
        await member.roles.remove(role.id).catch(() => {});
        await interaction.reply({ content: `↩️ Removed **${signal.label}** alerts.`, ephemeral: true }).catch(() => {});
      } else {
        await member.roles.add(role.id).catch(() => {});
        await interaction.reply({ content: `✅ Added **${signal.label}** alerts.`, ephemeral: true }).catch(() => {});
      }
      return true;
    }

    if (!interaction.isChatInputCommand() || !["signals-panel", "signal-panel"].includes(interaction.commandName)) return false;

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

    const sent = await ch.send({ embeds: [signalEmbed()], components: signalRows() }).catch(() => null);
    if (!sent) {
      await interaction.reply({ content: "❌ Failed to post signal panel (check channel permissions).", ephemeral: true }).catch(() => {});
      return true;
    }

    await interaction.reply({ content: `✅ Signal panel posted in <#${channelId}>.`, ephemeral: true }).catch(() => {});
    return true;
  }

  return { name: "signalroles", commands, handleInteraction };
}

module.exports = { createSignalRolesSystem };
