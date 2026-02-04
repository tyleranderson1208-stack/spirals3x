"use strict";

const fs = require("fs");
const path = require("path");
const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

function createRulesMenuSystem(client) {
  // ========= ENV =========
  const {
    VERIFY_ROLE_ID,
    MEMBER_ROLE_ID,
    RULES_ACK_VERSION,
    AUDIT_CHANNEL_ID,
    UI_FOOTER,
  } = process.env;

  const FOOTER = UI_FOOTER || "🌀 SPIRALS 3X";
  const ACK_VERSION = RULES_ACK_VERSION || "v1";

  // ========= STORAGE =========
  const DATA_DIR = path.join(__dirname, "data");
  const ACK_FILE = path.join(DATA_DIR, "rules_ack.json");

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
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
    fs.renameSync(tmp, file);
  }

  const ackDB = loadJsonSafe(ACK_FILE, { users: {} });

  function getAck(userId) {
    if (!ackDB.users[userId]) ackDB.users[userId] = { acknowledgedAt: 0, version: "" };
    return ackDB.users[userId];
  }

  function setAck(userId) {
    ackDB.users[userId] = {
      acknowledgedAt: Math.floor(Date.now() / 1000),
      version: ACK_VERSION,
    };
    saveJson(ACK_FILE, ackDB);
  }

  function isAcknowledged(member) {
    if (!member) return false;
    if (MEMBER_ROLE_ID && member.roles?.cache?.has(MEMBER_ROLE_ID)) return true;

    // fallback to stored ack (in case role was removed later, you can decide policy)
    const a = getAck(member.id);
    return Boolean(a.acknowledgedAt) && a.version === ACK_VERSION;
  }

  // ========= AUDIT =========
  async function auditLog(guild, embed) {
    if (!AUDIT_CHANNEL_ID) return;
    const ch = await guild.channels.fetch(AUDIT_CHANNEL_ID).catch(() => null);
    if (!ch || !("send" in ch)) return;
    await ch.send({ embeds: [embed] }).catch(() => {});
  }

  // ========= CONTENT (CONDENSED + PREMIUM) =========
  // “Server rules” = in-game rules (Rust server rules)
  const SERVER_RULES = [
    { title: "Gameplay Integrity", body: "No griefing, trapping, blocking, TC/deployable abuse, or building to interfere with other bases." },
    { title: "No Alliances", body: "Play only with your official team. No teaming, cooperation, shared defense, or coordinated raids with other groups." },
    { title: "Team Limits", body: "No bypassing limits: no rotating players, hidden members, or alt-account stacking." },
    { title: "Cheating Reports", body: "Cheating reports must go to Rust developers. Staff do not investigate or confirm cheat accusations." },
    { title: "Kit / Role Safety", body: "Leaving & rejoining Discord can affect kit roles. Keep proof of purchases—restores aren’t guaranteed without evidence." },
    { title: "ZORP / Protection Rules", body: "No abuse: don’t fake offline status. One ZORP per team. Protection must not show red while you’re online." },
    { title: "Enforcement", body: "Punishments scale by severity and history: warnings → suspensions → permanent bans." },
  ];

  // “Discord rules” = community conduct + channel hygiene
  const DISCORD_RULES = [
    { title: "Respect First", body: "No hate speech, slurs, harassment, racism, threats, or NSFW. Keep it welcoming." },
    { title: "No Staff Pings", body: "Don’t @ Owners/Admins for support—open a ticket. It’s faster and tracked." },
    { title: "No Spam / Flooding", body: "Avoid excessive caps, repeated messages, or derailing. Stay on-topic." },
    { title: "No Advertising", body: "No promo links, other servers, socials, or invites without staff approval." },
    { title: "Privacy", body: "No doxxing or sharing personal info (yours or others). Instant action for violations." },
    { title: "No Impersonation", body: "Don’t impersonate staff/members or mislead others." },
    { title: "No Backseat Moderation", body: "Report issues privately (tickets). Staff handles enforcement." },
    { title: "ToS + Exploits", body: "Follow Discord ToS. Cheating/exploiting (Discord or in-game) = removal." },
    { title: "Staff Decisions", body: "Appeals go via tickets. Don’t argue enforcement in public channels." },
  ];

  function premiumRulesEmbed(kind) {
    const isServer = kind === "server";
    const title = isServer ? "🌀 SPIRALS — Server Rules" : "🌀 SPIRALS — Discord Rules";
    const blocks = (isServer ? SERVER_RULES : DISCORD_RULES)
      .map((r) => `**${r.title}**\n${r.body}`)
      .join("\n\n");

    return new EmbedBuilder()
      .setColor(0xb100ff) // Spirals accent purple (matches your bot theme)
      .setTitle(title)
      .setDescription(
        `**Read carefully.** These rules apply at all times.\n\n${blocks}\n\n` +
          `When you’re ready, confirm below to unlock full access.`
      )
      .setFooter({ text: `${FOOTER} • Rules Version: ${ACK_VERSION}` });
  }

  function mainMenuEmbed() {
    return new EmbedBuilder()
      .setColor(0x00e5ff) // Spirals cyan
      .setTitle("🌀 SPIRALS — Rules & Acknowledgement")
      .setDescription(
        `Welcome to **SPIRALS**.\n\n` +
          `To keep the server clean, fair, and premium — you must review the rules and acknowledge them.\n\n` +
          `**Choose a ruleset below:**\n` +
          `• **Server Rules** (in-game)\n` +
          `• **Discord Rules** (community)\n\n` +
          `After reading, press **I Understand & Agree** to unlock full access.`
      )
      .setFooter({ text: FOOTER });
  }

  function menuRow() {
    return new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("rules:select")
        .setPlaceholder("Select which rules to review…")
        .addOptions(
          { label: "Server Rules (in-game)", value: "server", description: "Gameplay integrity, teams, ZORP, enforcement." },
          { label: "Discord Rules (community)", value: "discord", description: "Respect, spam, privacy, tickets, ToS." }
        )
    );
  }

  function confirmRow(kind) {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`rules:agree:${kind}`)
        .setLabel("I Understand & Agree")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId("rules:cancel")
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Secondary)
    );
  }

  // ========= COMMAND =========
  const commands = [
    new SlashCommandBuilder()
      .setName("rulesmenu")
      .setDescription("Post the SPIRALS rules & acknowledgement menu (mods/admins only)."),
  ];

  // ========= HELPERS =========
  function isModOrAdmin(member) {
    // Simple: anyone with ManageGuild or Administrator can post panel
    const perms = member?.permissions;
    if (!perms) return false;
    return perms.has("Administrator") || perms.has("ManageGuild");
  }

  async function postRulesMenu(interaction) {
    if (!isModOrAdmin(interaction.member)) {
      return interaction.reply({ content: "❌ Only staff can post the rules menu panel.", ephemeral: true });
    }

    await interaction.reply({
      embeds: [mainMenuEmbed()],
      components: [menuRow()],
    });
  }

  // ========= INTERACTIONS =========
  async function handleInteraction(interaction) {
    // /rulesmenu
    if (interaction.isChatInputCommand() && interaction.commandName === "rulesmenu") {
      await postRulesMenu(interaction);
      return true;
    }

    // select menu
    if (interaction.isStringSelectMenu() && interaction.customId === "rules:select") {
      const choice = interaction.values?.[0];
      const member = interaction.member;

      // Must at least be verified role to proceed (optional but recommended)
      if (VERIFY_ROLE_ID && !member?.roles?.cache?.has(VERIFY_ROLE_ID)) {
        await interaction.reply({
          content: "❌ Please verify first, then come back to acknowledge the rules.",
          ephemeral: true,
        });
        return true;
      }

      const embed = premiumRulesEmbed(choice);
      await interaction.reply({
        embeds: [embed],
        components: [confirmRow(choice)],
        ephemeral: true,
      });
      return true;
    }

    // cancel
    if (interaction.isButton() && interaction.customId === "rules:cancel") {
      await interaction.reply({ content: "✅ No problem — you can open the rules again anytime.", ephemeral: true });
      return true;
    }

    // agree
    if (interaction.isButton() && interaction.customId.startsWith("rules:agree:")) {
      const member = interaction.member;
      const guild = interaction.guild;

      if (!guild || !member) {
        await interaction.reply({ content: "❌ This action must be used in a server.", ephemeral: true });
        return true;
      }

      if (VERIFY_ROLE_ID && !member.roles.cache.has(VERIFY_ROLE_ID)) {
        await interaction.reply({ content: "❌ Please verify first, then acknowledge the rules.", ephemeral: true });
        return true;
      }

      // already acknowledged
      if (isAcknowledged(member)) {
        await interaction.reply({ content: "✅ You’ve already acknowledged the rules.", ephemeral: true });
        return true;
      }

      // persist ack
      setAck(member.id);

      // grant member role (if configured)
      if (MEMBER_ROLE_ID) {
        await member.roles.add(MEMBER_ROLE_ID).catch(() => {});
      }

      // audit
      await auditLog(
        guild,
        new EmbedBuilder()
          .setColor(0x0a1020)
          .setTitle("🧾 Rules Acknowledged")
          .setDescription(
            `User: <@${member.id}>\n` +
              `ID: \`${member.id}\`\n` +
              `Version: \`${ACK_VERSION}\`\n` +
              `Time: <t:${Math.floor(Date.now() / 1000)}:F>`
          )
          .setFooter({ text: FOOTER })
      );

      await interaction.reply({
        content: "✅ Rules acknowledged. Welcome in — you’re fully unlocked.",
        ephemeral: true,
      });

      return true;
    }

    return false;
  }

  // ========= PUBLIC API =========
  // Use this in your suggestions system to gate usage.
  function requireAcknowledged(interaction, { allowIfNoMemberRoleId = false } = {}) {
    const member = interaction.member;

    if (!member) return false;

    // If you haven’t set MEMBER_ROLE_ID yet, you can temporarily allow or block.
    if (!MEMBER_ROLE_ID) {
      return allowIfNoMemberRoleId;
    }

    return member.roles.cache.has(MEMBER_ROLE_ID);
  }

  return { commands, handleInteraction, requireAcknowledged };
}

module.exports = { createRulesMenuSystem };
