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
const UI_FOOTER = process.env.UI_FOOTER || "🌀 SPIRALS 3X • RHIB Racing";
const SIGNAL_BANNER_URL = process.env.SIGNAL_HUB_BANNER_URL || "https://media.discordapp.net/attachments/1468941702801916045/1477090974139416748/3c4cd911-5998-4ab3-9116-276822e0c73b.png?ex=69a37fab&is=69a22e2b&hm=37a719fd1f44227f96d07f8e98302a6041074c96084002bc52de889a62ddf328&=&format=webp&quality=lossless&width=385&height=257";

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
      new ButtonBuilder().setCustomId(`sig:${s.key}`).setLabel(s.label).setStyle(ButtonStyle.Primary)
    );
  });

  SIGNALS.slice(3, 6).forEach((s) => {
    row2.addComponents(
      new ButtonBuilder().setCustomId(`sig:${s.key}`).setLabel(s.label).setStyle(ButtonStyle.Primary)
    );
  });

  return [row1, row2];
}

function signalEmbed() {
  const lines = [
    `<@&${SIGNALS[0].roleId}>\n↳ Giveaway drops and winner calls.`,
    `<@&${SIGNALS[1].roleId}>\n↳ Poll opens, closes, and outcomes.`,
    `<@&${SIGNALS[2].roleId}>\n↳ Suggestion updates and staff decisions.`,
    `<@&${SIGNALS[3].roleId}>\n↳ Event announcements and reminders.`,
    `<@&${SIGNALS[4].roleId}>\n↳ Alerts when your team is being raided in-game.`,
    `<@&${SIGNALS[5].roleId}>\n↳ Nuke drop alerts so you can claim point rewards.`,
  ].join("\n\n");

  return new EmbedBuilder()
    .setColor(COLOR_PRIMARY)
    .setTitle(`${BRAND} — SIGNAL HUB`)
    .setDescription(
      [
        "The Spiral calls — align your signal path.",
        "",
        "Choose a channel and the alerts will find you when it matters.",
      ].join("\n")
    )
    .addFields(
      {
        name: "Signal Groups",
        value: `${lineA}\n${lineB}\n${lineC}`,
        inline: false,
      },
      {
        name: "Alert Groups",
        value: `${lineD}\n${lineE}\n${lineF}`,
        inline: false,
      }
    )
    .setFooter({ text: UI_FOOTER })
    .setImage(SIGNAL_BANNER_URL)
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

      await interaction.deferReply({ ephemeral: true }).catch(() => {});

      if (!isAdmin(interaction)) {
        await respondEphemeral(interaction, "❌ Admin only.");
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
    } catch (e) {
      console.error("signalroles handleInteraction error:", e?.message || e);
      await respondEphemeral(interaction, "❌ Signal panel error (check terminal).");
      return true;
    }
  }

  return { name: "signalroles", commands, handleInteraction };
}

module.exports = { createSignalRolesSystem };
