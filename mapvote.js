"use strict";

/**
 * 🌀 SPIRALS 3X — Wipe Schedule Panel + Map Vote (Monthly / Manual)
 *
 * What you get:
 * - A "Wipe Schedule Panel" embed that shows:
 *   • Current Map (image)
 *   • Last wipe time + relative timer
 *   • Next wipe time + relative timer
 *   • Vote status + auto-lock countdown (optional)
 *   • Extra "server info" lines (customizable)
 *
 * - A map vote system:
 *   • Admin posts vote with 2–5 map images
 *   • Voting buttons (one vote per user; can change until end/lock)
 *   • When vote ends: the panel updates with the winning map image immediately
 *   • Maps are generic (Map 1/Map 2/Map 3...) — no custom names required
 *
 * Manual wipe times:
 * - You set LAST and NEXT wipe timestamps via /wipe-set
 * - Optional reminders can fire relative to NEXT wipe (24h/1h/10m/wipe)
 *
 * Integration (bot.js):
 *   const { createWipeMapSystem } = require("./mapvote");
 *   const WIPEMAP = createWipeMapSystem(client);
 *   commandsDef.push(...WIPEMAP.commands);
 *   if (await WIPEMAP.handleInteraction(interaction)) return;
 *   WIPEMAP.onReady();
 */

const fs = require("fs");
const path = require("path");
const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionsBitField,
} = require("discord.js");

// ---------------- THEME ----------------
const BRAND = "🌀 SPIRALS 3X";
const COLOR_PRIMARY = 0xb100ff; // premium purple
const COLOR_ACCENT = 0x00e5ff; // neon cyan

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}
function clean(s, max = 120) {
  return String(s || "").trim().slice(0, max);
}
function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}
function pct(votes, total) {
  if (!total) return "0%";
  return `${Math.round((votes / total) * 100)}%`;
}
function bar(votes, total) {
  const len = 12;
  if (!total) return "▱".repeat(len);
  const filled = clamp(Math.round((votes / total) * len), 0, len);
  return "▰".repeat(filled) + "▱".repeat(len - filled);
}
function isAdmin(interaction) {
  return interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);
}
function envInt(v, def) {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : def;
}
function envBool(v, def = false) {
  if (typeof v === "undefined") return def;
  return String(v).toLowerCase() === "true";
}

// "YYYY-MM-DD HH:MM" (UTC)
function parseUtcToUnix(str) {
  const m = String(str || "").match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, Y, Mo, D, H, Mi] = m;
  const dt = new Date(Date.UTC(+Y, +Mo - 1, +D, +H, +Mi, 0));
  const unix = Math.floor(dt.getTime() / 1000);
  return Number.isFinite(unix) && unix > 0 ? unix : null;
}

async function getTextChannel(client, channelId) {
  if (!channelId) return null;
  const ch = await client.channels.fetch(channelId).catch(() => null);
  if (!ch) return null;
  if (!("send" in ch)) return null;
  return ch;
}

function createMapVoteSystem(client, commandsDef = []) {
  const cmd = new SlashCommandBuilder()
    .setName("mapvotepanel")
    .setDescription("Post a quick map vote panel (admin)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

  if (Array.isArray(commandsDef)) commandsDef.push(cmd);

  const embed = new EmbedBuilder()
    .setColor(COLOR_PRIMARY)
    .setTitle("🗺️ MAP VOTE")
    .setDescription("Vote for the next map below.");

  function buttons() {
    return [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("mapvote:map1").setLabel("Map 1").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("mapvote:map2").setLabel("Map 2").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("mapvote:map3").setLabel("Map 3").setStyle(ButtonStyle.Primary)
      ),
    ];
  }

  async function postPanel(interaction) {
    const channel = interaction.channel;
    if (!channel || !("send" in channel)) return;
    await channel.send({ embeds: [embed], components: buttons() }).catch(() => {});
  }

  async function handleInteraction(interaction) {
    if (interaction.isButton() && interaction.customId?.startsWith("mapvote:")) {
      await interaction.reply({ content: "✅ Vote recorded.", ephemeral: true }).catch(() => {});
      return true;
    }
    return false;
  }

  return { postPanel, handleInteraction };
}

// ---------------- STORAGE ----------------
function defaultData() {
  return {
    config: {
      panelChannelId: null,
      panelMessageId: null,
      voteChannelId: null,
      resultsChannelId: null,
      pingRoleId: null,
      remindersEnabled: true,
      pinResults: true,
    },
    wipe: {
      lastWipeUnix: null,
      nextWipeUnix: null,
      currentMapImageUrl: null,
      // Updated when a vote ends:
      nextMapImageUrl: null,
      // Optional extra lines shown on the panel (admin can set):
      infoLines: ["Monthly wipe • Maps chosen by vote", "Verify → Link Kaos → Read rules"],
    },
    vote: null, // active vote
    reminders: {
      nextWipeKey: null,
      sent: { h24: false, h1: false, m10: false, wipe: false },
    },
  };
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
function loadJson(file, fallback) {
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

// ---------------- FACTORY ----------------
function createWipeMapSystem(client) {
  const DATA_DIR = process.env.WIPEMAP_DATA_DIR
    ? path.resolve(process.env.WIPEMAP_DATA_DIR)
    : path.join(__dirname, "data");
  const DATA_FILE = path.join(DATA_DIR, "wipemap.json");

  const FOOTER =
    process.env.WIPEMAP_FOOTER ||
    "Spirals 3X • Monthly wipe • Map vote updates the panel • Premium systems online";

  // Auto-lock vote before wipe (seconds)
  const AUTOLOCK_BEFORE_WIPE_SEC = envInt(process.env.WIPEMAP_AUTOLOCK_BEFORE_WIPE_SEC, 60 * 60); // 1h default

  // Reminder windows (tight)
  const REMINDERS = {
    h24: envBool(process.env.WIPEMAP_REMIND_24H, true),
    h1: envBool(process.env.WIPEMAP_REMIND_1H, true),
    m10: envBool(process.env.WIPEMAP_REMIND_10M, true),
    wipe: envBool(process.env.WIPEMAP_REMIND_WIPE, true),
  };

  // Load + patch
  let data = loadJson(DATA_FILE, defaultData());
  (function patch() {
    const base = defaultData();
    data.config = { ...base.config, ...(data.config || {}) };
    data.wipe = { ...base.wipe, ...(data.wipe || {}) };
    if (!Array.isArray(data.wipe.infoLines)) data.wipe.infoLines = base.wipe.infoLines.slice();
    if (typeof data.vote === "undefined") data.vote = null;
    data.reminders = { ...base.reminders, ...(data.reminders || {}) };
    if (!data.reminders.sent) data.reminders.sent = { h24: false, h1: false, m10: false, wipe: false };
    saveJson(DATA_FILE, data);
  })();

  // ---------------- PANEL EMBED ----------------
  function panelEmbed() {
    const w = data.wipe;
    const last = w.lastWipeUnix ? `**<t:${w.lastWipeUnix}:F>**\n<t:${w.lastWipeUnix}:R>` : "`Not set`";
    const next = w.nextWipeUnix ? `**<t:${w.nextWipeUnix}:F>**\n**<t:${w.nextWipeUnix}:R>**` : "`Not set`";

    const voteStatus = (() => {
      if (!data.vote) return "— `No active vote`";
      const lockAt = w.nextWipeUnix ? w.nextWipeUnix - AUTOLOCK_BEFORE_WIPE_SEC : null;
      const locked = data.vote.lockedAtUnix ? "🔒 **LOCKED**" : "✅ **OPEN**";
      const lockLine = lockAt ? `Auto-lock: <t:${lockAt}:R>` : "Auto-lock: `unknown`";
      return `${locked}\nVote ends: <t:${data.vote.endsAtUnix}:R>\n${lockLine}`;
    })();

    const mapLine = w.currentMapImageUrl ? "✅ **LIVE**" : "⏳ **Awaiting map selection**";
    const nextMapLine = w.nextMapImageUrl ? "✅ **Locked in**" : data.vote ? "🗳️ **Voting live**" : "— `Not set`";

    const info =
      (w.infoLines || [])
        .slice(0, 6)
        .map((x) => `• ${clean(x, 120)}`)
        .join("\n") || "• —";

    const e = new EmbedBuilder()
      .setColor(COLOR_PRIMARY)
      .setTitle(`${BRAND} — WIPE SCHEDULE`)
      .setDescription(
        [
          "```ansi\n\u001b[2;35mSYSTEM:\u001b[0m \u001b[2;36mONLINE\u001b[0m   \u001b[2;35m|\u001b[0m   \u001b[2;35mCYCLE:\u001b[0m \u001b[2;36mMONTHLY\u001b[0m   \u001b[2;35m|\u001b[0m   \u001b[2;35mMAP:\u001b[0m \u001b[2;36mVOTED\u001b[0m\n```",
          "The Spiral rotates on schedule.\nYour vote shapes what comes next.",
        ].join("\n")
      )
      .addFields(
        { name: "🗺️ CURRENT MAP (LIVE)", value: mapLine, inline: true },
        { name: "🧿 NEXT MAP (LOCKED)", value: nextMapLine, inline: true },
        { name: "🧊 LAST WIPE (UTC)", value: last, inline: true },
        { name: "🔥 NEXT WIPE (UTC)", value: next, inline: true },
        { name: "🗳️ MAP VOTE", value: voteStatus, inline: true },
        { name: "📌 SERVER NOTES", value: info, inline: false }
      )
      .setFooter({ text: FOOTER })
      .setTimestamp();

    // Big image = current map (if set)
    if (w.currentMapImageUrl) e.setImage(w.currentMapImageUrl);

    // Thumbnail = next map preview (if locked)
    if (w.nextMapImageUrl) e.setThumbnail(w.nextMapImageUrl);

    return e;
  }

  async function refreshPanel() {
    const { panelChannelId, panelMessageId } = data.config;
    if (!panelChannelId || !panelMessageId) return;

    const ch = await getTextChannel(client, panelChannelId);
    if (!ch || !("messages" in ch)) return;

    const msg = await ch.messages.fetch(panelMessageId).catch(() => null);
    if (!msg) return;

    await msg.edit({ embeds: [panelEmbed()] }).catch(() => {});
  }

  function pingText() {
    if (!data.config.pingRoleId) return "";
    return `<@&${data.config.pingRoleId}> `;
  }

  async function postAndMaybePin(channel, payload) {
    const msg = await channel.send(payload).catch(() => null);
    if (!msg) return null;
    if (data.config.pinResults) await msg.pin().catch(() => {});
    return msg;
  }

  // ---------------- VOTE EMBEDS ----------------
  function tallyCounts(v) {
    const counts = new Array(v.options.length).fill(0);
    for (const uid of Object.keys(v.ballots)) {
      const idx = v.ballots[uid];
      if (Number.isInteger(idx) && idx >= 0 && idx < counts.length) counts[idx]++;
    }
    return counts;
  }

  function voteEmbed(v) {
    const counts = tallyCounts(v);
    const total = Object.keys(v.ballots).length;

    const lines = v.options.map((o, i) => {
      const votes = counts[i];
      return [`**Map ${i + 1}**`, `\`${bar(votes, total)}\`  **${pct(votes, total)}**  •  \`${votes}\` votes`].join("\n");
    });

    const lockAt = data.wipe.nextWipeUnix ? data.wipe.nextWipeUnix - AUTOLOCK_BEFORE_WIPE_SEC : null;
    const lockLine = lockAt
      ? `**Auto-lock:** <t:${lockAt}:F> (**<t:${lockAt}:R>**)`
      : "**Auto-lock:** `Set NEXT wipe to enable`";

    const nextWipeLine = data.wipe.nextWipeUnix
      ? `**Next wipe:** <t:${data.wipe.nextWipeUnix}:F> (**<t:${data.wipe.nextWipeUnix}:R>**)`
      : "**Next wipe:** `Not set yet`";

    const status = v.lockedAtUnix ? "🔒 **LOCKED FOR WIPE**" : "✅ **OPEN**";

    return new EmbedBuilder()
      .setColor(COLOR_ACCENT)
      .setTitle(`🗳️ ${BRAND} — MAP VOTE`)
      .setDescription(
        [
          "```ansi\n\u001b[2;36mVOTE:\u001b[0m \u001b[2;36mLIVE\u001b[0m   \u001b[2;35m|\u001b[0m   \u001b[2;36mWINNER:\u001b[0m \u001b[2;36mUPDATES PANEL\u001b[0m\n```",
          status,
          "",
          ...lines,
          "",
          `**Voters:** \`${total}\``,
          `**Vote ends:** <t:${v.endsAtUnix}:F> (**<t:${v.endsAtUnix}:R>**)`,
          lockLine,
          nextWipeLine,
          "",
          "⬇️ Tap a button to vote (you can change until it ends or locks).",
          "🖼️ Images are in the **Map Previews** thread under this message.",
        ].join("\n")
      )
      .setFooter({ text: FOOTER });
  }

  function voteButtons(v, disabled = false) {
    const row = new ActionRowBuilder();
    for (let i = 0; i < v.options.length; i++) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`wmv_${i}`)
          .setLabel(`${i + 1}`)
          .setEmoji("🗳️")
          .setStyle(ButtonStyle.Primary)
          .setDisabled(disabled)
      );
    }
    return [row];
  }

  async function postPreviewsThread(voteMsg, options) {
    const thread = await voteMsg
      .startThread({
        name: "🗺️ Map Previews",
        autoArchiveDuration: 1440,
        reason: "Spirals 3X map previews",
      })
      .catch(() => null);

    if (!thread) return null;

    const intro = new EmbedBuilder()
      .setColor(COLOR_PRIMARY)
      .setTitle("🌀 MAP PREVIEWS")
      .setDescription("View the maps below, then vote in the main message.\nUse full-screen for clarity.")
      .setFooter({ text: FOOTER });

    await thread.send({ embeds: [intro] }).catch(() => {});

    for (let i = 0; i < options.length; i++) {
      const o = options[i];
      const e = new EmbedBuilder()
        .setColor(COLOR_ACCENT)
        .setTitle(`Map ${i + 1}`)
        .setImage(o.imageUrl)
        .setFooter({ text: "Vote in the main message above" });

      await thread.send({ embeds: [e] }).catch(() => {});
    }

    return thread.id;
  }

  function pickWinner(v) {
    const counts = tallyCounts(v);
    const total = Object.keys(v.ballots).length;

    let bestIdx = 0;
    let bestVotes = -1;
    for (let i = 0; i < counts.length; i++) {
      if (counts[i] > bestVotes) {
        bestVotes = counts[i];
        bestIdx = i;
      }
    }
    return { bestIdx, bestVotes, counts, total };
  }

  function resultsEmbed(v, winnerImageUrl, winnerVotes, totalVotes, reason) {
    return new EmbedBuilder()
      .setColor(COLOR_PRIMARY)
      .setTitle(`🏆 ${BRAND} — MAP LOCKED`)
      .setDescription(
        [
          "```ansi\n\u001b[2;35mRESULT:\u001b[0m \u001b[2;36mLOCKED\u001b[0m   \u001b[2;35m|\u001b[0m   \u001b[2;35mEFFECT:\u001b[0m \u001b[2;36mPANEL UPDATED\u001b[0m\n```",
          `**Winner:** \`Map ${v.winnerIndex + 1}\``,
          `**Votes:** \`${winnerVotes}\` / \`${totalVotes}\` (${pct(winnerVotes, totalVotes)})`,
          "",
          reason ? `**Ended:** ${reason}` : "",
          "",
          "✅ The Wipe Schedule panel has been updated with the locked map.",
        ]
          .filter(Boolean)
          .join("\n")
      )
      .setImage(winnerImageUrl)
      .setFooter({ text: FOOTER })
      .setTimestamp();
  }

  async function endVote(reason) {
    if (!data.vote) return;
    const v = data.vote;

    const { bestIdx, bestVotes, total } = pickWinner(v);
    const winnerOpt = v.options[bestIdx];
    // Update panel immediately: NEXT MAP thumbnail + also set "current map" if you want it live now
    // Your request: when voting ends, map updated on panel. We'll lock it in as "next map".
    data.wipe.nextMapImageUrl = winnerOpt.imageUrl;

    // Edit the vote message -> results
    const voteCh = await getTextChannel(client, v.channelId);
    if (voteCh && "messages" in voteCh) {
      const msg = await voteCh.messages.fetch(v.messageId).catch(() => null);
      if (msg) {
        const embed = resultsEmbed({ ...v, winnerIndex: bestIdx }, winnerOpt.imageUrl, bestVotes, total, reason);
        await msg.edit({ embeds: [embed], components: [] }).catch(() => {});
      }
    }

    // Post results to results channel
    const resultsChId = data.config.resultsChannelId || data.config.panelChannelId || v.channelId;
    const resultsCh = await getTextChannel(client, resultsChId);
    if (resultsCh) {
      const embed = resultsEmbed({ ...v, winnerIndex: bestIdx }, winnerOpt.imageUrl, bestVotes, total, reason);
      await postAndMaybePin(resultsCh, {
        content: `${pingText()}🏁 **Map vote concluded — panel updated.**`,
        embeds: [embed],
      });
    }

    data.vote = null;
    saveJson(DATA_FILE, data);

    await refreshPanel();
  }

  async function autoLockVoteIfDue() {
    if (!data.vote) return;
    if (!data.wipe.nextWipeUnix) return; // need next wipe to lock-before-wipe

    const now = nowUnix();
    const lockAt = data.wipe.nextWipeUnix - AUTOLOCK_BEFORE_WIPE_SEC;

    if (data.vote.lockedAtUnix) return;
    if (now >= lockAt) {
      data.vote.lockedAtUnix = now;
      saveJson(DATA_FILE, data);
      await endVote("Auto-locked before wipe");
    }
  }

  // ---------------- REMINDERS ----------------
  function bumpReminderKey() {
    const key = data.wipe.nextWipeUnix ? String(data.wipe.nextWipeUnix) : null;
    if (data.reminders.nextWipeKey !== key) {
      data.reminders.nextWipeKey = key;
      data.reminders.sent = { h24: false, h1: false, m10: false, wipe: false };
    }
  }

  async function sendRemindersIfDue() {
    if (!data.config.remindersEnabled) return;
    if (!data.wipe.nextWipeUnix) return;

    bumpReminderKey();

    const now = nowUnix();
    const next = data.wipe.nextWipeUnix;
    const diff = next - now;

    const outChannelId = data.config.resultsChannelId || data.config.panelChannelId;
    const ch = await getTextChannel(client, outChannelId);
    if (!ch) return;

    const make = (title, desc) =>
      new EmbedBuilder().setColor(COLOR_ACCENT).setTitle(title).setDescription(desc).setFooter({ text: FOOTER }).setTimestamp();

    if (REMINDERS.h24 && !data.reminders.sent.h24 && diff <= 24 * 3600 && diff > 23 * 3600) {
      data.reminders.sent.h24 = true;
      saveJson(DATA_FILE, data);
      await ch
        .send({
          content: `${pingText()}🧊 **Wipe reminder — 24 hours**`,
          embeds: [
            make(`${BRAND} — WIPE IN 24H`, `**Next wipe:** <t:${next}:F> (**<t:${next}:R>**)\n🗳️ If a map vote is live, lock it in.`),
          ],
        })
        .catch(() => {});
    }

    if (REMINDERS.h1 && !data.reminders.sent.h1 && diff <= 3600 && diff > 50 * 60) {
      data.reminders.sent.h1 = true;
      saveJson(DATA_FILE, data);
      await ch
        .send({
          content: `${pingText()}🔥 **Wipe reminder — 1 hour**`,
          embeds: [
            make(`${BRAND} — WIPE IN 1H`, `**Next wipe:** <t:${next}:F> (**<t:${next}:R>**)\n🔒 Votes may auto-lock around now.`),
          ],
        })
        .catch(() => {});
    }

    if (REMINDERS.m10 && !data.reminders.sent.m10 && diff <= 10 * 60 && diff > 8 * 60) {
      data.reminders.sent.m10 = true;
      saveJson(DATA_FILE, data);
      await ch
        .send({
          content: `${pingText()}⚡ **Wipe reminder — 10 minutes**`,
          embeds: [make(`${BRAND} — WIPE IN 10M`, `**Next wipe:** <t:${next}:F> (**<t:${next}:R>**)`)],
        })
        .catch(() => {});
    }

    if (REMINDERS.wipe && !data.reminders.sent.wipe && diff <= 0) {
      data.reminders.sent.wipe = true;
      saveJson(DATA_FILE, data);
      await ch
        .send({
          content: `${pingText()}💥 **WIPE IS LIVE NOW**`,
          embeds: [make(`${BRAND} — WIPE NOW`, `**Wipe time:** <t:${next}:F>\n🌀 The Spiral resets.`)],
        })
        .catch(() => {});
    }
  }

  // ---------------- COMMANDS ----------------
  const commands = [
    new SlashCommandBuilder()
      .setName("wipe-panel")
      .setDescription("Create the Wipe Schedule panel (admin only)")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addChannelOption((o) => o.setName("channel").setDescription("Channel to post the panel").setRequired(true)),

    new SlashCommandBuilder()
      .setName("wipe-setup")
      .setDescription("Set channels + settings for wipe/mapvote (admin only)")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addChannelOption((o) => o.setName("vote_channel").setDescription("Where map votes are posted").setRequired(true))
      .addChannelOption((o) => o.setName("results_channel").setDescription("Where results/reminders post (optional)").setRequired(false))
      .addRoleOption((o) => o.setName("ping_role").setDescription("Role ping for reminders/results (optional)").setRequired(false))
      .addBooleanOption((o) => o.setName("reminders").setDescription("Enable wipe reminders (default true)").setRequired(false))
      .addBooleanOption((o) => o.setName("pin_results").setDescription("Auto-pin results (default true)").setRequired(false)),

    new SlashCommandBuilder()
      .setName("wipe-set")
      .setDescription("Manually set last/next wipe timestamps (UTC) (admin only)")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addStringOption((o) => o.setName("last_utc").setDescription('Last wipe: "YYYY-MM-DD HH:MM" (UTC)').setRequired(true))
      .addStringOption((o) => o.setName("next_utc").setDescription('Next wipe: "YYYY-MM-DD HH:MM" (UTC)').setRequired(true)),

    new SlashCommandBuilder()
      .setName("wipe-map")
      .setDescription("Set the current LIVE map image (admin only)")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addAttachmentOption((o) => o.setName("image").setDescription("Current map image").setRequired(true)),

    new SlashCommandBuilder()
      .setName("wipe-notes")
      .setDescription("Set panel notes (1-6 lines) (admin only)")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addStringOption((o) => o.setName("lines").setDescription("Separate lines using | (max 6)").setRequired(true)),

    new SlashCommandBuilder()
      .setName("mapvote-start")
      .setDescription("Start a map vote (images). Maps are generic. (admin only)")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addIntegerOption((o) =>
        o.setName("duration_minutes").setDescription("Vote duration").setRequired(true).setMinValue(1).setMaxValue(720)
      )
      .addAttachmentOption((o) => o.setName("map1_image").setDescription("Map 1 image").setRequired(true))
      .addAttachmentOption((o) => o.setName("map2_image").setDescription("Map 2 image").setRequired(true))
      .addAttachmentOption((o) => o.setName("map3_image").setDescription("Map 3 image (optional)").setRequired(false))
      .addAttachmentOption((o) => o.setName("map4_image").setDescription("Map 4 image (optional)").setRequired(false))
      .addAttachmentOption((o) => o.setName("map5_image").setDescription("Map 5 image (optional)").setRequired(false))
      .addBooleanOption((o) => o.setName("ping").setDescription("Ping configured role when vote starts").setRequired(false)),

    new SlashCommandBuilder()
      .setName("mapvote-end")
      .setDescription("Force end the current vote (admin only)")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  ];

  // ---------------- INTERACTIONS ----------------
  async function handleInteraction(interaction) {
    try {
      // Buttons (vote)
      if (interaction.isButton() && interaction.customId.startsWith("wmv_")) {
        if (!data.vote) return interaction.reply({ content: "Voting isn’t active.", ephemeral: true });

        const v = data.vote;
        if (interaction.message.id !== v.messageId) {
          return interaction.reply({ content: "This vote is no longer active.", ephemeral: true });
        }

        const now = nowUnix();
        if (v.lockedAtUnix) return interaction.reply({ content: "🔒 Vote locked for wipe.", ephemeral: true });
        if (now >= v.endsAtUnix) return interaction.reply({ content: "⏳ Voting ended.", ephemeral: true });

        const m = interaction.customId.match(/^wmv_(\d+)$/);
        if (!m) return interaction.reply({ content: "Invalid vote button.", ephemeral: true });
        const idx = parseInt(m[1], 10);

        if (!Number.isInteger(idx) || idx < 0 || idx >= v.options.length) {
          return interaction.reply({ content: "Invalid option.", ephemeral: true });
        }

        v.ballots[interaction.user.id] = idx;
        saveJson(DATA_FILE, data);

        await interaction.message
          .edit({
            embeds: [voteEmbed(v)],
            components: voteButtons(v, false),
          })
          .catch(() => {});

        return interaction.reply({ content: `✅ Vote cast: **Map ${idx + 1}**`, ephemeral: true });
      }

      // Slash commands
      if (!interaction.isChatInputCommand()) return false;

      const name = interaction.commandName;
      const adminOnly = ["wipe-panel", "wipe-setup", "wipe-set", "wipe-map", "wipe-notes", "mapvote-start", "mapvote-end"].includes(name);
      if (adminOnly && !isAdmin(interaction)) return interaction.reply({ content: "❌ Admin only.", ephemeral: true });

      if (name === "wipe-panel") {
        const ch = interaction.options.getChannel("channel", true);
        const msg = await ch.send({ embeds: [panelEmbed()] });

        data.config.panelChannelId = ch.id;
        data.config.panelMessageId = msg.id;
        saveJson(DATA_FILE, data);

        return interaction.reply({ content: `✅ Wipe panel created in <#${ch.id}>`, ephemeral: true });
      }

      if (name === "wipe-setup") {
        const voteCh = interaction.options.getChannel("vote_channel", true);
        const resultsCh = interaction.options.getChannel("results_channel", false);
        const pingRole = interaction.options.getRole("ping_role", false);
        const reminders = interaction.options.getBoolean("reminders");
        const pinResults = interaction.options.getBoolean("pin_results");

        data.config.voteChannelId = voteCh.id;
        if (resultsCh) data.config.resultsChannelId = resultsCh.id;
        if (pingRole) data.config.pingRoleId = pingRole.id;
        if (typeof reminders === "boolean") data.config.remindersEnabled = reminders;
        if (typeof pinResults === "boolean") data.config.pinResults = pinResults;

        saveJson(DATA_FILE, data);
        await refreshPanel();

        return interaction.reply({
          content: `✅ Setup saved.\n• Vote: <#${data.config.voteChannelId}>\n• Results: ${
            data.config.resultsChannelId ? `<#${data.config.resultsChannelId}>` : "`not set (uses panel)`"
          }\n• Reminders: \`${data.config.remindersEnabled}\`\n• Pin results: \`${data.config.pinResults}\`\n• Ping role: ${
            data.config.pingRoleId ? `<@&${data.config.pingRoleId}>` : "`none`"
          }`,
          ephemeral: true,
        });
      }

      if (name === "wipe-set") {
        const lastStr = interaction.options.getString("last_utc", true);
        const nextStr = interaction.options.getString("next_utc", true);

        const lastUnix = parseUtcToUnix(lastStr);
        const nextUnix = parseUtcToUnix(nextStr);

        if (!lastUnix || !nextUnix) {
          return interaction.reply({ content: '❌ Format must be: `YYYY-MM-DD HH:MM` (UTC)', ephemeral: true });
        }
        if (nextUnix <= lastUnix) {
          return interaction.reply({ content: "❌ Next wipe must be after last wipe.", ephemeral: true });
        }

        data.wipe.lastWipeUnix = lastUnix;
        data.wipe.nextWipeUnix = nextUnix;

        // Reset reminder state when next wipe changes
        data.reminders.nextWipeKey = String(nextUnix);
        data.reminders.sent = { h24: false, h1: false, m10: false, wipe: false };

        saveJson(DATA_FILE, data);
        await refreshPanel();

        return interaction.reply({
          content: `✅ Wipe times saved.\nLast: <t:${lastUnix}:F>\nNext: <t:${nextUnix}:F>`,
          ephemeral: true,
        });
      }

      if (name === "wipe-map") {
        const img = interaction.options.getAttachment("image", true);
        data.wipe.currentMapImageUrl = img.url;
        saveJson(DATA_FILE, data);
        await refreshPanel();
        return interaction.reply({ content: "✅ Current map image updated on the panel.", ephemeral: true });
      }

      if (name === "wipe-notes") {
        const raw = interaction.options.getString("lines", true);
        const parts = raw
          .split("|")
          .map((s) => clean(s, 120))
          .filter(Boolean)
          .slice(0, 6);
        data.wipe.infoLines = parts.length ? parts : defaultData().wipe.infoLines.slice();
        saveJson(DATA_FILE, data);
        await refreshPanel();
        return interaction.reply({ content: "✅ Panel notes updated.", ephemeral: true });
      }

      if (name === "mapvote-start") {
        if (data.vote) return interaction.reply({ content: "❌ A vote is already active.", ephemeral: true });
        if (!data.config.voteChannelId) return interaction.reply({ content: "❌ Run `/wipe-setup` first.", ephemeral: true });
        if (!data.config.panelChannelId || !data.config.panelMessageId) {
          return interaction.reply({ content: "❌ Run `/wipe-panel` first.", ephemeral: true });
        }

        const duration = interaction.options.getInteger("duration_minutes", true);
        const ping = interaction.options.getBoolean("ping") || false;

        const imgs = [];
        const a1 = interaction.options.getAttachment("map1_image", true);
        const a2 = interaction.options.getAttachment("map2_image", true);
        imgs.push(a1.url, a2.url);

        const a3 = interaction.options.getAttachment("map3_image", false);
        const a4 = interaction.options.getAttachment("map4_image", false);
        const a5 = interaction.options.getAttachment("map5_image", false);
        if (a3) imgs.push(a3.url);
        if (a4) imgs.push(a4.url);
        if (a5) imgs.push(a5.url);

        const opts = imgs.map((url) => ({ imageUrl: url }));

        const voteCh = await getTextChannel(client, data.config.voteChannelId);
        if (!voteCh) return interaction.reply({ content: "❌ Vote channel not accessible.", ephemeral: true });

        const endsAtUnix = nowUnix() + duration * 60;

        data.vote = {
          channelId: voteCh.id,
          messageId: null,
          threadId: null,
          endsAtUnix,
          options: opts,
          ballots: {},
          lockedAtUnix: null,
        };
        saveJson(DATA_FILE, data);

        const content = ping ? `${pingText()}🗳️ **MAP VOTE LIVE — choose what the Spiral reveals next.**` : null;

        const msg = await voteCh.send({
          content,
          embeds: [voteEmbed(data.vote)],
          components: voteButtons(data.vote, false),
        });

        data.vote.messageId = msg.id;
        saveJson(DATA_FILE, data);

        const threadId = await postPreviewsThread(msg, opts);
        data.vote.threadId = threadId;
        saveJson(DATA_FILE, data);

        await refreshPanel();

        return interaction.reply({ content: `✅ Vote started in <#${voteCh.id}> (ends <t:${endsAtUnix}:R>).`, ephemeral: true });
      }

      if (name === "mapvote-end") {
        if (!data.vote) return interaction.reply({ content: "❌ No active vote.", ephemeral: true });
        await endVote("Force-ended by admin");
        return interaction.reply({ content: "✅ Vote ended. Panel updated.", ephemeral: true });
      }

      return false;
    } catch (e) {
      console.error("wipemap handleInteraction error:", e);
      if (!interaction.replied) {
        try {
          await interaction.reply({ content: "❌ Wipe/Map system error (check logs).", ephemeral: true });
        } catch {}
      }
      return true;
    }
  }

  // ---------------- LOOP ----------------
  let intervalHandle = null;

  async function tick() {
    try {
      // Auto-lock vote before wipe (only works if NEXT wipe set)
      await autoLockVoteIfDue();

      // Vote expiry
      if (data.vote && nowUnix() >= data.vote.endsAtUnix && !data.vote.lockedAtUnix) {
        await endVote("Time expired");
      }

      // Reminders
      await sendRemindersIfDue();

      // Keep panel fresh (timers)
      await refreshPanel();
    } catch (e) {
      console.error("wipemap tick error:", e);
    }
  }

  function onReady() {
    // Ensure reminder key is synced
    if (data.wipe.nextWipeUnix) {
      data.reminders.nextWipeKey = String(data.wipe.nextWipeUnix);
    }
    saveJson(DATA_FILE, data);

    if (!intervalHandle) intervalHandle = setInterval(tick, 60 * 1000);
    tick().catch(() => {});
  }

  return {
    name: "wipemap",
    commands,
    handleInteraction,
    onReady,
  };
}

module.exports = { createMapVoteSystem, createWipeMapSystem };
