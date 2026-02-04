"use strict";

/**
 * SPIRALS 3X — Onboarding
 * - Welcome message on join (premium embed + optional GIF)
 * - Optional audit log post to an audit channel
 * - Auto-delete welcome message after X hours (default 24)
 *
 * NOTE:
 * - Welcome channel is view-only: perfect.
 * - No anti-alt, no temp roles, no server status.
 */

const { EmbedBuilder } = require("discord.js");

function buildWelcomeEmbed({ BRAND, FOOTER, COLOR_PRIMARY, COLOR_ACCENT, member, guild, welcomeChannelId, rulesChannelId }) {
  const welcomeChannelMention = welcomeChannelId ? `<#${welcomeChannelId}>` : "`welcome channel`";
  const rulesMention = rulesChannelId ? `<#${rulesChannelId}>` : "`rules`";

  return new EmbedBuilder()
    .setColor(COLOR_PRIMARY)
    .setTitle(`🌀 Welcome to ${BRAND}`)
    .setDescription(
      `Hey ${member} — glad you’re here.\n\n` +
        `This server is built to feel **premium**: clean spaces, top-tier features, and a community that actually moves.\n\n` +
        `**Next step:** head to **Verification** and unlock full access.\n` +
        `After verifying, check ${rulesMention}.\n\n` +
        `🌀 Enjoy the waves — see you inside.`
    )
    .addFields(
      { name: "Getting Started", value: `✅ Verify to unlock the server\n📜 Read ${rulesMention} after verifying\n💡 Drop ideas once you’re in`, inline: false }
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

function buildAuditEmbed({ BRAND, FOOTER, COLOR_NEUTRAL, member }) {
  return new EmbedBuilder()
    .setColor(COLOR_NEUTRAL)
    .setTitle(`🧾 ${BRAND} — Join Audit`)
    .setDescription(`🌀 Member joined: ${member} (\`${member.id}\`)`)
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

function parseIntSafe(v, fallback) {
  const n = parseInt(String(v || ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

function createOnboardingSystem(client, opts) {
  const BRAND = opts?.brand || "🌀 SPIRALS 3X";
  const FOOTER = opts?.footer || "🌀 SPIRALS 3X";

  const COLOR_PRIMARY = opts?.colorPrimary ?? 0x00e5ff;
  const COLOR_ACCENT = opts?.colorAccent ?? 0xb100ff;
  const COLOR_NEUTRAL = opts?.colorNeutral ?? 0x0a1020;

  const WELCOME_CHANNEL_ID = opts?.welcomeChannelId || "";
  const AUDIT_CHANNEL_ID = opts?.auditChannelId || "";
  const RULES_CHANNEL_ID = opts?.rulesChannelId || "";

  const WELCOME_GIF_URL = (opts?.welcomeGifUrl || "").trim(); // optional
  const DELETE_AFTER_HOURS = parseIntSafe(opts?.welcomeDeleteAfterHours, 24);

  async function sendWelcome(member) {
    if (!WELCOME_CHANNEL_ID) return;

    const ch = await member.guild.channels.fetch(WELCOME_CHANNEL_ID).catch(() => null);
    if (!ch || !("send" in ch)) return;

    const embed = buildWelcomeEmbed({
      BRAND,
      FOOTER,
      COLOR_PRIMARY,
      COLOR_ACCENT,
      member,
      guild: member.guild,
      welcomeChannelId: WELCOME_CHANNEL_ID,
      rulesChannelId: RULES_CHANNEL_ID,
    });

    // If you set a GIF URL, we show it as the embed image
    if (WELCOME_GIF_URL) embed.setImage(WELCOME_GIF_URL);

    const msg = await ch.send({ embeds: [embed] }).catch(() => null);
    if (!msg) return;

    // Auto-delete after X hours
    if (DELETE_AFTER_HOURS > 0) {
      const ms = Math.max(60_000, DELETE_AFTER_HOURS * 60 * 60 * 1000);
      setTimeout(() => {
        msg.delete().catch(() => {});
      }, ms);
    }
  }

  async function sendAudit(member) {
    if (!AUDIT_CHANNEL_ID) return;

    const ch = await member.guild.channels.fetch(AUDIT_CHANNEL_ID).catch(() => null);
    if (!ch || !("send" in ch)) return;

    const embed = buildAuditEmbed({ BRAND, FOOTER, COLOR_NEUTRAL, member });
    await ch.send({ embeds: [embed] }).catch(() => {});
  }

  function register() {
    // Fires when a user joins (works if bot has GuildMembers intent in code;
    // may require enabling "Server Members Intent" in the Developer Portal if your server is large)
    client.on("guildMemberAdd", async (member) => {
      try {
        await sendWelcome(member);
        await sendAudit(member);
      } catch (e) {
        console.log("Onboarding error:", e?.message || e);
      }
    });
  }

  return { register };
}

module.exports = { createOnboardingSystem };
