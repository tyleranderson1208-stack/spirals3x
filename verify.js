"use strict";

/**
 * SPIRALS 3X — Verify Panel (Slash Command)
 * - /verifypanel posts a premium verify panel in the current channel
 * - Verify button gives VERIFIED_ROLE_ID (works as re-verify)
 * - Optional rules channel link in success message
 */

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionsBitField,
} = require("discord.js");

function buildVerifyEmbed({ BRAND, FOOTER, COLOR_ACCENT }) {
  return new EmbedBuilder()
    .setColor(COLOR_ACCENT)
    .setTitle(`🌀 ${BRAND} — Verification`)
    .setDescription(
      `**Welcome to ${BRAND}.**\n\n` +
        `You're one step away from full access.\n\n` +
        `🌀 **Tap Verify** to unlock:\n` +
        `• Get the **Verified** role instantly\n` +
        `• Re-verify anytime if your role gets removed\n\n` +
        `Ready? Hit **Verify / Re-Verify** below 👇`
    )
    .setFooter({ text: FOOTER });
}

function buildVerifyRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("verify:press")
      .setLabel("Verify / Re-Verify")
      .setStyle(ButtonStyle.Primary)
  );
}

function createVerifySystem(client, commandsDef, opts) {
  const BRAND = opts?.brand || "🌀 SPIRALS 3X";
  const FOOTER = opts?.footer || "🌀 SPIRALS 3X";
  const COLOR_ACCENT = opts?.colorAccent ?? 0xb100ff;

  const VERIFIED_ROLE_ID = opts?.verifiedRoleId || "";
  const RULES_CHANNEL_ID = opts?.rulesChannelId || "";

  const cmd = new SlashCommandBuilder()
    .setName("verifypanel")
    .setDescription("Post the verification panel in this channel.")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild); // admins/mods

  commandsDef.push(cmd);

  async function postPanel(interaction) {
    const embed = buildVerifyEmbed({ BRAND, FOOTER, COLOR_ACCENT });
    const row = buildVerifyRow();
    await interaction.reply({ embeds: [embed], components: [row] });
  }

  async function handleVerifyPress(interaction) {
    const guild = interaction.guild;
    if (!guild) return true;

    if (!VERIFIED_ROLE_ID) {
      await interaction.reply({ content: "❌ VERIFIED_ROLE_ID is missing in .env", ephemeral: true }).catch(() => {});
      return true;
    }

    const role = await guild.roles.fetch(VERIFIED_ROLE_ID).catch(() => null);
    if (!role) {
      await interaction.reply({ content: "❌ Verified role not found. Check VERIFIED_ROLE_ID.", ephemeral: true }).catch(() => {});
      return true;
    }

    const me = guild.members.me;
    if (!me?.permissions?.has(PermissionsBitField.Flags.ManageRoles)) {
      await interaction.reply({ content: "❌ I need **Manage Roles** permission to verify users.", ephemeral: true }).catch(() => {});
      return true;
    }

    // Role hierarchy check
    if (role.position >= me.roles.highest.position) {
      await interaction.reply({
        content: "❌ I can’t assign the Verified role because it’s above (or equal to) my highest role.",
        ephemeral: true,
      }).catch(() => {});
      return true;
    }

    const member = await guild.members.fetch(interaction.user.id).catch(() => null);
    if (!member) {
      await interaction.reply({ content: "❌ Couldn’t fetch your member profile. Try again.", ephemeral: true }).catch(() => {});
      return true;
    }

    const already = member.roles.cache.has(role.id);

    if (!already) {
      await member.roles.add(role.id, "User verified via verify panel").catch(async () => {
        await interaction.reply({
          content: "❌ I couldn’t assign your role. Check permissions and role hierarchy.",
          ephemeral: true,
        }).catch(() => {});
        return;
      });

      const rulesLine = RULES_CHANNEL_ID ? `\n📜 Rules: <#${RULES_CHANNEL_ID}>` : "";
      await interaction.reply({ content: `🌀 **Verified.** Welcome in.${rulesLine}`, ephemeral: true }).catch(() => {});
      return true;
    }

    const rulesLine = RULES_CHANNEL_ID ? `\n📜 Rules: <#${RULES_CHANNEL_ID}>` : "";
    await interaction.reply({ content: `🌀 You’re already verified.${rulesLine}`, ephemeral: true }).catch(() => {});
    return true;
  }

  async function handleInteraction(interaction) {
    if (interaction.isChatInputCommand?.() && interaction.commandName === "verifypanel") {
      await postPanel(interaction);
      return true;
    }

    if (interaction.isButton?.() && interaction.customId === "verify:press") {
      await handleVerifyPress(interaction);
      return true;
    }

    return false;
  }

  return { handleInteraction };
}

module.exports = { createVerifySystem };
