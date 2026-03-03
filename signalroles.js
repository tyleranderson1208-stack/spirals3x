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

const BRAND = ":blackhole: STELLAR 3X";
const COLOR_PRIMARY = 0xb100ff;
const UI_FOOTER = process.env.UI_FOOTER || ":blackhole: STELLAR 3X • RHIB Racing";
const SIGNAL_BANNER_URL =
  process.env.SIGNAL_HUB_BANNER_URL ||
  "https://media.discordapp.net/attachments/1468941702801916045/1477090974139416748/3c4cd911-5998-4ab3-9116-276822e0c73b.png?ex=69a37fab&is=69a22e2b&hm=37a719fd1f44227f96d07f8e98302a6041074c96084002bc52de889a62ddf328&=&format=webp&quality=lossless&width=385&height=257";

const DEFAULT_PANEL_CHANNEL_ID = process.env.SIGNAL_ROLES_CHANNEL_ID || "1465517573108928628";

const SIGNALS = [
  {
    key: "giveaways",
    label: "Giveaways",
    emoji: "🎁",
    roleId: process.env.SIGNAL_ROLE_GIVEAWAYS || "1477073449259106528",
    description: "Giveaway drops and winner calls.",
  },
  {
    key: "polls",
    label: "Polls",
    emoji: "🗳️",
    roleId: process.env.SIGNAL_ROLE_POLLS || "1477073705606840451",
    description: "Poll opens, closes, and outcomes.",
  },
  {
    key: "suggestions",
    label: "Suggestions",
    emoji: "💡",
    roleId: process.env.SIGNAL_ROLE_SUGGESTIONS || "1477073787240583289",
    description: "Suggestion updates and staff decisions.",
  },
  {
    key: "events",
    label: "Events",
    emoji: "📅",
    roleId: process.env.SIGNAL_ROLE_EVENTS || "1477073813739933847",
    description: "Event announcements and reminders.",
  },
  {
    key: "raid",
    label: "Raid Alerts",
    emoji: "🚨",
    roleId: process.env.SIGNAL_ROLE_RAID || "1477073911572070583",
    description: "Alerts when your team is being raided in-game.",
  },
  {
    key: "nuke",
    label: "Nuke Alerts",
    emoji: "☢️",
    roleId: process.env.SIGNAL_ROLE_NUKE || "1477073963694686281",
    description: "Nuke drop alerts so you can claim point rewards.",
  },
  {
    key: "wipe",
    label: "Wipe Alerts",
    emoji: "🗺️",
    roleId: process.env.SIGNAL_ROLE_WIPE || "1478395613719691274",
    description: "Wipe-related alerts like map voting updates and countdowns.",
  },
];

function isAdmin(interaction) {
  return interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);
}

function signalRows() {
  const rows = [];
  for (let i = 0; i < SIGNALS.length; i += 5) {
    const row = new ActionRowBuilder();
    SIGNALS.slice(i, i + 5).forEach((signal) => {
      row.addComponents(
        new ButtonBuilder().setCustomId(`sig:${signal.key}`).setLabel(signal.label).setEmoji(signal.emoji).setStyle(ButtonStyle.Primary)
      );
    });
    rows.push(row);
  }
  return rows;
}

function signalEmbed() {
  const lines = SIGNALS.map((signal) => `<@&${signal.roleId}>\n↳ ${signal.description}`).join("\n\n");

  return new EmbedBuilder()
    .setColor(COLOR_PRIMARY)
    .setTitle(`🛰️ ${BRAND} — SIGNAL HUB`)
    .setDescription(["The Spiral calls — align your signal path.", "", "Choose a channel and the alerts will find you when it matters.", "", lines].join("\n"))
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
  ];

  if (Array.isArray(commandsDef)) commandsDef.push(...commands);

  async function respondEphemeral(interaction, content) {
    if (interaction.deferred) {
      return interaction.editReply({ content }).catch(() => {});
    }
    if (interaction.replied) {
      return interaction.followUp({ content, ephemeral: true }).catch(() => {});
    }
    return interaction.reply({ content, ephemeral: true }).catch(() => {});
  }

  async function handleInteraction(interaction) {
    try {
      if (interaction.isButton() && interaction.customId?.startsWith("sig:")) {
        const key = interaction.customId.split(":")[1] || "";
        const signal = SIGNALS.find((s) => s.key === key);
        if (!signal) {
          await respondEphemeral(interaction, "❌ Unknown signal role.");
          return true;
        }

        const guild = interaction.guild;
        const memberId = interaction.user?.id;
        if (!guild || !memberId) {
          await respondEphemeral(interaction, "❌ Server/member context unavailable.");
          return true;
        }

        const member = await guild.members.fetch(memberId).catch(() => null);
        if (!member) {
          await respondEphemeral(interaction, "❌ Could not load your member profile.");
          return true;
        }

        const role = await guild.roles.fetch(signal.roleId).catch(() => null);
        if (!role) {
          await respondEphemeral(interaction, `❌ Role for ${signal.label} is missing.`);
          return true;
        }

        const has = member.roles.cache.has(role.id);
        if (has) {
          await member.roles.remove(role.id).catch(() => {});
          await respondEphemeral(interaction, `↩️ Removed **${signal.label}** alerts.`);
        } else {
          await member.roles.add(role.id).catch(() => {});
          await respondEphemeral(interaction, `✅ Added **${signal.label}** alerts.`);
        }
        return true;
      }

      if (!interaction.isChatInputCommand() || interaction.commandName !== "signals-panel") return false;
      if (!isAdmin(interaction)) {
        await respondEphemeral(interaction, "❌ Admin only.");
        return true;
      }

      const guild = interaction.guild;
      if (!guild) {
        await respondEphemeral(interaction, "❌ Server context unavailable.");
        return true;
      }

      const channelOpt = interaction.options.getChannel("channel", false);
      const channelId = channelOpt?.id || DEFAULT_PANEL_CHANNEL_ID;
      const ch = await client.channels.fetch(channelId).catch(() => null);
      if (!ch || !("send" in ch)) {
        await respondEphemeral(interaction, "❌ Target channel is not accessible.");
        return true;
      }

      const sent = await ch.send({ embeds: [signalEmbed()], components: signalRows() }).catch(() => null);
      if (!sent) {
        await respondEphemeral(interaction, "❌ Failed to post signal panel (check channel permissions).");
        return true;
      }

      await respondEphemeral(interaction, `✅ Signal panel posted in <#${channelId}>.`);
      return true;
    } catch (err) {
      console.error("signalroles handleInteraction error:", err);
      await respondEphemeral(interaction, "❌ Signal roles encountered an error.");
      return true;
    }
  }

  return { name: "signalroles", commands, handleInteraction };
}

module.exports = { createSignalRolesSystem };
