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

function getRoleMention(roleId) {
  return roleId ? `<@&${roleId}>` : "";
}

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
  linkChannelId,
  rulesChannelId,
  gifUrl,
  brand,
}) {
  const roleLines = [getRoleMention(verifyRoleId)];
  if (memberRoleId) roleLines.push(getRoleMention(memberRoleId));

  const afterLines = [];
  if (linkChannelId) afterLines.push(`• Link Kaos in ${getChannelMention(linkChannelId)}`);
  if (rulesChannelId) afterLines.push(`• Run \`/rulesmenu\` in ${getChannelMention(rulesChannelId)}`);

  const embed = new EmbedBuilder()
    .setColor(colorAccent ?? DEFAULT_COLOR)
    .setTitle("🌀 Verification — Unlock SPIRALS 3X")
    .setDescription(
      `Welcome to **${brand}**.\nPress **Verify** below to unlock the server.\n\n` +
        `**You’ll receive:**\n${roleLines.map((r) => `• ${r}`).join("\n")}\n\n` +
        `**After verification:**\n${afterLines.length ? afterLines.join("\n") : "• Follow the server setup steps."}`
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
  announcementsChannelId,
  wipeScheduleChannelId,
}) {
  const steps = [];
  if (linkChannelId) steps.push(`1) Link Kaos in ${getChannelMention(linkChannelId)}`);
  if (rulesChannelId) steps.push(`2) Run \`/rulesmenu\` in ${getChannelMention(rulesChannelId)}`);
  if (announcementsChannelId) steps.push(`3) Updates in ${getChannelMention(announcementsChannelId)}`);
  if (wipeScheduleChannelId) steps.push(`4) Wipe info in ${getChannelMention(wipeScheduleChannelId)}`);

  const nextSteps = steps.length ? steps.join("\n") : "Follow the server setup steps shared by staff.";

  return new EmbedBuilder()
    .setColor(colorAccent ?? DEFAULT_COLOR)
    .setTitle("✅ Verified — Welcome to SPIRALS 3X")
    .setDescription(
      "You are verified and roles have been applied.\n\n" +
        "**Next steps (recommended):**\n" +
        `${nextSteps}\n\n` +
        "If your roles are ever removed, you can press **Verify** again."
    )
    .setFooter({ text: footerText || DEFAULT_FOOTER });
}

function createVerifySystem(client, commandsDef, opts = {}) {
  const brand = opts.brand || "🌀 SPIRALS 3X";
  const footerText = process.env.UI_FOOTER || opts.footer || DEFAULT_FOOTER;
  const colorAccent = opts.colorAccent ?? DEFAULT_COLOR;

  const verifyRoleId = process.env.VERIFY_ROLE_ID || "";
  const memberRoleId = process.env.MEMBER_ROLE_ID || "";
  const panelGifUrl = process.env.VERIFY_PANEL_GIF_URL || "";
  const linkChannelId = process.env.LINK_CHANNEL_ID || "";
  const rulesChannelId = process.env.RULES_CHANNEL_ID || "";
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
      linkChannelId,
      rulesChannelId,
      gifUrl: panelGifUrl,
      brand,
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
