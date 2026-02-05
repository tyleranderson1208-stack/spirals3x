"use strict";

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionsBitField,
} = require("discord.js");

const DEFAULT_COLOR = 0xb100ff;
const DEFAULT_FOOTER = "🌀 SPIRALS 3X • Verification Protocol";

function getChannelMention(channelId) {
  return channelId ? `<#${channelId}>` : "";
}

function canManageRole(me, role) {
  if (!me || !role) return false;
  if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) return false;
  return me.roles.highest?.comparePositionTo(role) > 0;
}

function buildPanelEmbed({
  colorAccent,
  footerText,
  verifyRoleId,
  memberRoleId,
  gifUrl,
}) {
  const embed = new EmbedBuilder()
    .setColor(colorAccent ?? DEFAULT_COLOR)
    .setTitle("🌀 The Threshold — SPIRALS 3X")
    .setDescription(
      "Welcome to SPIRALS 3X.\n\n" +
        "You’re standing at the edge of the Spiral.\n" +
        "Press Verify to step through and unlock the server.\n\n" +
        "If you ever lose access, return here and press Verify again."
    )
    .setFooter({ text: footerText || DEFAULT_FOOTER });

  if (gifUrl) embed.setImage(gifUrl);
  return embed;
}

function buildNextStepsEmbed({
  colorAccent,
  footerText,
  linkChannelId,
  rulesChannelId,
  serverInfoChannelId,
  ticketsChannelId,
  announcementsChannelId,
  wipeScheduleChannelId,
}) {
  const steps = [];
  if (linkChannelId) steps.push(`• Link your in-game name with Kaos in ${getChannelMention(linkChannelId)}`);
  if (rulesChannelId) steps.push(`• Read the rules in ${getChannelMention(rulesChannelId)}`);
  if (serverInfoChannelId) steps.push(`• Learn server details in ${getChannelMention(serverInfoChannelId)}`);
  if (announcementsChannelId) steps.push(`• Updates in ${getChannelMention(announcementsChannelId)}`);
  if (wipeScheduleChannelId) steps.push(`• Wipe info in ${getChannelMention(wipeScheduleChannelId)}`);
  if (ticketsChannelId) steps.push(`• Support in ${getChannelMention(ticketsChannelId)}`);

  const nextSteps = steps.length ? steps.join("\n") : "Follow the server setup steps shared by staff.";

  return new EmbedBuilder()
    .setColor(colorAccent ?? DEFAULT_COLOR)
    .setTitle("✅ Marked by the Spiral")
    .setDescription(
      "Welcome to SPIRALS 3X.\n" +
        "The threshold is behind you.\n" +
        "Your role has been bound, and the spiral now recognizes you as one of its own.\n\n" +
        "**Your next movements**\n" +
        `${nextSteps}\n\n` +
        "If your roles are ever removed, come back and press Verify again."
    )
    .setFooter({ text: footerText || DEFAULT_FOOTER });
}

function createVerifySystem(client, commandsDef, opts = {}) {
  const footerText = process.env.UI_FOOTER || opts.footer || DEFAULT_FOOTER;
  const colorAccent = opts.colorAccent ?? DEFAULT_COLOR;

  const verifyRoleId = process.env.VERIFY_ROLE_ID || "";
  const memberRoleId = process.env.MEMBER_ROLE_ID || "";
  const panelGifUrl = process.env.VERIFY_PANEL_GIF_URL || "";
  const linkChannelId = process.env.LINK_CHANNEL_ID || "";
  const rulesChannelId = process.env.RULES_CHANNEL_ID || "";
  const serverInfoChannelId = process.env.SERVER_INFO_CHANNEL_ID || "";
  const ticketsChannelId = process.env.TICKETS_CHANNEL_ID || "";
  const announcementsChannelId = process.env.ANNOUNCEMENTS_CHANNEL_ID || "";
  const wipeScheduleChannelId = process.env.WIPE_SCHEDULE_CHANNEL_ID || "";

  const cmd = new SlashCommandBuilder()
    .setName("verifypanel")
    .setDescription("Post the verification panel (admin)")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

  if (Array.isArray(commandsDef)) commandsDef.push(cmd);

  async function handlePanel(interaction) {
    if (!verifyRoleId) {
      return interaction.reply({
        content: "❌ VERIFY_ROLE_ID is not configured. Staff must set this in .env.",
        ephemeral: true,
      });
    }

    const embed = buildPanelEmbed({
      colorAccent,
      footerText,
      verifyRoleId,
      memberRoleId,
      gifUrl: panelGifUrl,
    });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("verify:press").setLabel("Verify").setStyle(ButtonStyle.Success)
    );

    await interaction.channel?.send({ embeds: [embed], components: [row] }).catch(() => {});
    return interaction.reply({ content: "✅ Verification panel posted.", ephemeral: true });
  }

  async function handleVerify(interaction) {
    if (!verifyRoleId) {
      return interaction.reply({
        content: "❌ VERIFY_ROLE_ID is not configured. Staff must set this in .env.",
        ephemeral: true,
      });
    }

    const guild = interaction.guild;
    const member = interaction.member;
    if (!guild || !member) return interaction.reply({ content: "❌ This must be used in a server.", ephemeral: true });

    const verifyRole = await guild.roles.fetch(verifyRoleId).catch(() => null);
    if (!verifyRole) {
      return interaction.reply({
        content: "❌ Verify role not found. Staff must check VERIFY_ROLE_ID.",
        ephemeral: true,
      });
    }

    const memberRole = memberRoleId ? await guild.roles.fetch(memberRoleId).catch(() => null) : null;

    const me = guild.members.me;
    if (!canManageRole(me, verifyRole) || (memberRole && !canManageRole(me, memberRole))) {
      return interaction.reply({
        content:
          "❌ I cannot assign the verify role. Staff must ensure my role is above the target roles and I have Manage Roles.",
        ephemeral: true,
      });
    }

    const alreadyVerified = member.roles?.cache?.has(verifyRoleId);
    const alreadyMember = memberRoleId ? member.roles?.cache?.has(memberRoleId) : true;

    if (!alreadyVerified || !alreadyMember) {
      const rolesToAdd = [verifyRoleId];
      if (memberRoleId) rolesToAdd.push(memberRoleId);
      await member.roles.add(rolesToAdd).catch(() => null);
    }

    const nextSteps = buildNextStepsEmbed({
      colorAccent,
      footerText,
      linkChannelId,
      rulesChannelId,
      serverInfoChannelId,
      ticketsChannelId,
      announcementsChannelId,
      wipeScheduleChannelId,
    });

    const message = alreadyVerified && alreadyMember ? "✅ You are already verified." : "✅ Verification complete.";

    return interaction.reply({ content: message, embeds: [nextSteps], ephemeral: true });
  }

  async function handleInteraction(interaction) {
    if (interaction.isChatInputCommand() && interaction.commandName === "verifypanel") {
      return handlePanel(interaction);
    }

    if (interaction.isButton() && interaction.customId === "verify:press") {
      return handleVerify(interaction);
    }

    return false;
  }

  return { commands: [cmd], handleInteraction };
}

module.exports = { createVerifySystem };
