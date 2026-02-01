require("dotenv").config();

const { initTicketSystem } = require("./tickets");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  PermissionsBitField,
  WebhookClient,
} = require("discord.js");

// ================== GLOBAL SAFETY ==================
process.on("unhandledRejection", (reason) => console.error("Unhandled rejection:", reason));
process.on("uncaughtException", (err) => console.error("Uncaught exception:", err));

// ================== BRAND (SPIRALS) ==================
const BRAND = "🌀 SPIRALS 3X";
const CURRENCY_NAME = "Spirals"; // display only (Kaos uses POINTS)

// Neon palette (cyan + purple)
const COLOR_PRIMARY = 0x00e5ff; // neon cyan
const COLOR_ACCENT = 0xb100ff; // neon purple
const COLOR_DARK = 0x050012; // deep dark purple
const COLOR_NEUTRAL = 0x0a1020; // dark blue-neutral

// Customizable footer via .env
// UI_FOOTER=🌀 SPIRALS 3X • RHIB Racing
const FOOTER = process.env.UI_FOOTER || "🌀 SPIRALS 3X • RHIB Racing";

// Deploy commands toggle (recommended live: false)
const DEPLOY_COMMANDS = (process.env.DEPLOY_COMMANDS || "false").toLowerCase() === "true";

// Optional cap to reduce spam/rate limits (default 12)
const MAX_ACTIVE_SOLO_RACES_PER_GUILD = Math.max(
  1,
  parseInt(process.env.MAX_ACTIVE_SOLO_RACES_PER_GUILD || "12", 10) || 12
);

// Optional ping role when party lobby created
const RACE_PING_ROLE_ID = process.env.RACE_PING_ROLE_ID || "";
function pingRoleText() {
  return RACE_PING_ROLE_ID ? `<@&${RACE_PING_ROLE_ID}>` : "";
}

// ================== ENV ==================
const {
  DISCORD_TOKEN,
  CLIENT_ID,
  GUILD_ID,
  KAOS_CHANNEL_ID,
  KAOS_USE_WEBHOOK,
  KAOS_WEBHOOK_URL,
  AUDIT_CHANNEL_ID,
} = process.env;

const useWebhook = (KAOS_USE_WEBHOOK || "false").toLowerCase() === "true";
const kaosWebhook =
  useWebhook && KAOS_WEBHOOK_URL ? new WebhookClient({ url: KAOS_WEBHOOK_URL }) : null;

// ================== DATA PATHS ==================
const DATA_DIR = path.join(__dirname, "data");
const TOKENS_FILE = path.join(DATA_DIR, "tokens.json");
const STATS_FILE = path.join(DATA_DIR, "racestats.json");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

const DEFAULT_SETTINGS = {
  freezeRaces: false,
  freezePayouts: false,
  seasonLengthDays: 14,
};
const DEFAULT_TOKENS = { users: {} };
const DEFAULT_STATS = {
  meta: { seasonStart: Date.now(), seasonNumber: 1 },
  users: {},
};

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

// safer write: write temp -> rename, keep .bak
function saveJson(file, obj) {
  ensureDir(path.dirname(file));

  const tmp = `${file}.tmp`;
  const bak = `${file}.bak`;

  try {
    // backup existing
    if (fs.existsSync(file)) {
      try {
        fs.copyFileSync(file, bak);
      } catch {}
    }

    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {}
    console.error("saveJson error:", e?.message || e);
  }
}

// ================== SETTINGS ==================
const settings = loadJsonSafe(SETTINGS_FILE, { ...DEFAULT_SETTINGS });
function saveSettings() {
  saveJson(SETTINGS_FILE, settings);
}

// ================== TOKENS DB ==================
const tokenDB = loadJsonSafe(TOKENS_FILE, { ...DEFAULT_TOKENS });

function getTok(userId) {
  if (!tokenDB.users[userId]) tokenDB.users[userId] = { tokens: 0, lastDaily: 0 };
  if (typeof tokenDB.users[userId].lastDaily !== "number") tokenDB.users[userId].lastDaily = 0;
  if (typeof tokenDB.users[userId].tokens !== "number") tokenDB.users[userId].tokens = 0;
  return tokenDB.users[userId];
}
function saveTokens() {
  saveJson(TOKENS_FILE, tokenDB);
}

// ================== STATS DB ==================
function newUserStats() {
  return {
    races: 0,
    wins: 0,
    totalWon: 0,
    bestFinish: 99,
    podiums: 0,
    winStreak: 0,
    bestWinStreak: 0,
    achievements: {},
  };
}

const statsDB = loadJsonSafe(STATS_FILE, { ...DEFAULT_STATS });

function getStats(userId) {
  if (!statsDB.users[userId]) statsDB.users[userId] = newUserStats();
  return statsDB.users[userId];
}
function saveStats() {
  saveJson(STATS_FILE, statsDB);
}

// Patch old racestats.json files
if (!statsDB.meta || typeof statsDB.meta !== "object") {
  statsDB.meta = { seasonStart: Date.now(), seasonNumber: 1 };
}
if (!statsDB.users || typeof statsDB.users !== "object") {
  statsDB.users = {};
}
saveStats();

function ensureDataFiles() {
  ensureDir(DATA_DIR);
  if (!fs.existsSync(SETTINGS_FILE)) saveJson(SETTINGS_FILE, { ...DEFAULT_SETTINGS });
  if (!fs.existsSync(TOKENS_FILE)) saveJson(TOKENS_FILE, { ...DEFAULT_TOKENS });
  if (!fs.existsSync(STATS_FILE)) saveJson(STATS_FILE, { ...DEFAULT_STATS });
}

function seasonCheckAndResetIfNeeded() {
  const days = settings.seasonLengthDays || 14;
  const ms = days * 24 * 60 * 60 * 1000;
  const start = statsDB.meta?.seasonStart || Date.now();
  if (Date.now() - start >= ms) {
    statsDB.users = {};
    statsDB.meta = {
      seasonStart: Date.now(),
      seasonNumber: (statsDB.meta?.seasonNumber || 1) + 1,
    };
    saveStats();
    console.log(`🧼 Season auto-reset. New season #${statsDB.meta.seasonNumber}`);
  }
}

// ================== SEEDED RNG (audit transparency) ==================
function newSeed() {
  return crypto.randomInt(1, 2147483647);
}
function makeRng(seed) {
  let t = seed >>> 0;
  return function rng() {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// ================== GAME CONFIG ==================
const DAILY_TOKENS = 1;

// Risk tiers (token costs: 1/2/3)
const TIERS = {
  low: { key: "low", label: "Low", emoji: "🧯", tokenCost: 1, payouts: { 1: 250000, 2: 75000, 3: 25000, 4: 10000, 5: 5000 } },
  standard: { key: "standard", label: "Standard", emoji: "🧨", tokenCost: 2, payouts: { 1: 1000000, 2: 250000, 3: 60000, 4: 30000, 5: 15000 } },
  high: { key: "high", label: "High", emoji: "🔥", tokenCost: 3, payouts: { 1: 2000000, 2: 500000, 3: 120000, 4: 60000, 5: 30000 } },
};

const TRACK_LEN = 18;
const TICK_MS = 1400;

// Cooldowns
const SOLO_COOLDOWN_SEC = 90;
const PARTY_COOLDOWN_SEC = 150;

const lastSoloPlay = new Map();
const lastPartyPlay = new Map();

function nowSec() {
  return Math.floor(Date.now() / 1000);
}
function onCooldown(map, userId, cd) {
  const t = map.get(userId) || 0;
  const left = t + cd - nowSec();
  return left > 0 ? left : 0;
}
function setCooldown(map, userId) {
  map.set(userId, nowSec());
}

// ================== COLOURS ==================
const COLOURS = [
  { key: "red", label: "🔴", name: "Red" },
  { key: "blue", label: "🔵", name: "Blue" },
  { key: "green", label: "🟢", name: "Green" },
  { key: "yellow", label: "🟡", name: "Yellow" },
  { key: "purple", label: "🟣", name: "Purple" },
];
const COLOUR_BY_KEY = new Map(COLOURS.map((c) => [c.key, c]));

// ================== UI ==================
function header(title) {
  return `**${title}** • ${BRAND} • 🏁 RHIB RACE`;
}
function tag(uid) {
  return `<@${uid}>`;
}
function placeBadge(place) {
  if (place === 1) return "🥇";
  if (place === 2) return "🥈";
  if (place === 3) return "🥉";
  if (place === 4) return "4️⃣";
  return "5️⃣";
}
function pct(pos) {
  const p = Math.max(0, Math.min(TRACK_LEN - 1, pos));
  return Math.round(((p + 1) / TRACK_LEN) * 100);
}

// Custom emoji named "rhib"
function getRhibEmoji(guild) {
  const e = guild?.emojis?.cache?.find((x) => x.name?.toLowerCase() === "rhib");
  return e ? e.toString() : "🚤";
}

// Clean centered track
function renderLine(col, pos, badge = "", rhibEmoji = "🚤") {
  const waves = Array.from("🌊".repeat(TRACK_LEN));
  const p = Math.min(TRACK_LEN - 1, Math.max(0, pos));
  waves[p] = rhibEmoji;
  return `${col.label}: ${waves.join("")} 🏁 ${badge}`.trim();
}

function payoutTableText(tier) {
  const p = tier.payouts;
  return [
    `🥇 1st: ${p[1].toLocaleString()} ${CURRENCY_NAME}`,
    `🥈 2nd: ${p[2].toLocaleString()} ${CURRENCY_NAME}`,
    `🥉 3rd: ${p[3].toLocaleString()} ${CURRENCY_NAME}`,
    `4️⃣ 4th: ${p[4].toLocaleString()} ${CURRENCY_NAME}`,
    `5️⃣ 5th: ${p[5].toLocaleString()} ${CURRENCY_NAME}`,
  ].join("\n");
}

function tierLine(tier) {
  return `${tier.emoji} **${tier.label}** • Cost: **${tier.tokenCost} token(s)**`;
}

function buildHelpEmbed() {
  return new EmbedBuilder()
    .setColor(COLOR_ACCENT)
    .setTitle(`📌 ${BRAND} — RHIB Racing Guide`)
    .setDescription(
      `${header("HOW IT WORKS")}\n\n` +
        `🎟️ **Tokens:**\n` +
        `• Daily: \`/tokens daily\` (**${DAILY_TOKENS}/day**)\n` +
        `• Balance: \`/balance\`\n\n` +
        `🏇 **Solo:** \`/race colour:<colour> tier:<low|standard|high>\`\n` +
        `👥 **Party:**\n` +
        `• \`/raceparty create tier:<low|standard|high> colour:<colour>\` (auto-starts in 60s)\n` +
        `• \`/raceparty join colour:<colour>\` (unique colours)\n` +
        `• \`/raceparty start\` (host, optional)\n\n` +
        `🎚️ **Risk Tiers:**\n` +
        `${tierLine(TIERS.low)}\n` +
        `${tierLine(TIERS.standard)}\n` +
        `${tierLine(TIERS.high)}\n\n` +
        `💰 **Payouts depend on tier** (Kaos queued).\n\n` +
        `📊 Stats: \`/racestats\`\n` +
        `🏆 Leaderboards: \`/top\`, \`/topwins\``
    )
    .setFooter({ text: FOOTER });
}

// ================== PERMISSIONS CHECK ==================
function missingPerms(channel, me) {
  try {
    const perms = channel.permissionsFor(me);
    if (!perms) return ["Unknown"];
    const missing = [];
    if (!perms.has(PermissionsBitField.Flags.SendMessages)) missing.push("Send Messages");
    if (!perms.has(PermissionsBitField.Flags.EmbedLinks)) missing.push("Embed Links");
    return missing;
  } catch {
    return ["Unknown"];
  }
}

// ================== AUDIT LOG ==================
async function auditLog(guild, embed) {
  if (!AUDIT_CHANNEL_ID) return;
  const ch = await guild.channels.fetch(AUDIT_CHANNEL_ID).catch(() => null);
  if (!ch || !("send" in ch)) return;
  await ch.send({ embeds: [embed] }).catch(() => {});
}

// ================== KAOS PAYOUT (BATCHED) ==================
async function kaosAddPoints(guild, discordId, amount) {
  if (!KAOS_CHANNEL_ID) {
    console.warn("⚠️ KAOS_CHANNEL_ID missing; payouts skipped.");
    return;
  }
  const cmd = `[KAOS][ADD][<@${discordId}>][1]=[POINTS][${amount}]`;

  if (useWebhook) {
    if (!kaosWebhook) {
      console.warn("⚠️ KAOS_USE_WEBHOOK=true but KAOS_WEBHOOK_URL missing; payouts skipped.");
      return;
    }
    await kaosWebhook.send({ content: cmd }).catch(() => {});
    return;
  }

  const ch = await guild.channels.fetch(KAOS_CHANNEL_ID).catch(() => null);
  if (!ch || !("send" in ch)) {
    console.warn("⚠️ KAOS_CHANNEL_ID not found or not text channel; payouts skipped.");
    return;
  }
  await ch.send({ content: cmd }).catch(() => {});
}

const payoutQueueByGuild = new Map(); // guildId -> Promise chain
function enqueuePayout(guild, discordId, amount) {
  const guildId = guild.id;
  const prev = payoutQueueByGuild.get(guildId) || Promise.resolve();

  const next = prev
    .then(async () => {
      await new Promise((r) => setTimeout(r, 850));
      if (settings.freezePayouts) return;
      await kaosAddPoints(guild, discordId, amount);
    })
    .catch(() => {});

  payoutQueueByGuild.set(guildId, next);
  return next;
}

// ================== WOW PRESENTATION ==================
const CINEMATIC = [
  "📡 **Scanning tide charts…**",
  "🧨 **Priming flares…**",
  "🌫️ **Fog rolling in…**",
  "🚨 **Launch clearance granted…**",
];

const COMMENTARY = [
  "📣 *“That wake is violent!”*",
  "📣 *“Someone’s cutting inside!”*",
  "📣 *“Engine screaming — massive push!”*",
  "📣 *“The surf is eating them alive!”*",
  "📣 *“This is going to be close…”*",
  "📣 *“What a line!”*",
];

function rand(arr, rng) {
  return arr[Math.floor(rng() * arr.length)];
}

// ================== MOVEMENT / HOUSE EDGE ==================
function rollBaseStep(rng) {
  const r = rng();
  if (r > 0.992) return 3;
  if (r > 0.93) return 2;
  if (r > 0.58) return 1;
  return 0;
}
function maybeEvent(rng) {
  const r = rng();
  if (r < 0.06) return { kind: "BOOST", text: "🧨 Boost wake!" };
  if (r < 0.10) return { kind: "STALL", text: "🌫️ Engine sputter..." };
  return null;
}
function houseEdgeModifier(rankIndex, total, tierKey, rng) {
  let drag = 0;
  const strength = tierKey === "high" ? 1.0 : tierKey === "standard" ? 0.7 : 0.55;

  if (rankIndex === 0 && rng() < 0.55 * strength) drag -= 1;
  if (rankIndex === 1 && rng() < 0.25 * strength) drag -= 1;

  if (rankIndex >= total - 2 && rng() < 0.45 * strength) drag += 1;
  if (rankIndex >= total - 1 && rng() < 0.65 * strength) drag += 1;

  return drag;
}
function streakPenalty(winStreak, tierKey, rng) {
  if (!winStreak || winStreak <= 0) return 0;
  const mult = tierKey === "high" ? 1.15 : tierKey === "standard" ? 1.0 : 0.85;
  const chance = Math.min(0.22, 0.08 + winStreak * 0.045) * mult;
  return rng() < chance ? -1 : 0;
}
function finalSprintBoost(pos, rng) {
  if (pos < TRACK_LEN - 5) return 0;
  return rng() < 0.18 ? 1 : 0;
}

// ================== ACHIEVEMENTS ==================
const ACH = {
  FIRST_RACE: { key: "first_race", name: "First Splash", tokens: 1 },
  FIRST_WIN: { key: "first_win", name: "Harbor Legend", tokens: 2 },
  PHOTO_FINISH: { key: "photo_finish", name: "Photo Finish", tokens: 1 },
  STREAK_3: { key: "streak_3", name: "On Fire", tokens: 2 },
  PODIUM_5: { key: "podium_5", name: "Podium Hunter", tokens: 2 },
  PARTY_WIN: { key: "party_win", name: "Crew Captain", tokens: 2 },
};

function awardAchievement(userId, achKey) {
  const s = getStats(userId);
  if (s.achievements?.[achKey]) return null;

  const def = Object.values(ACH).find((a) => a.key === achKey);
  if (!def) return null;

  s.achievements[achKey] = Date.now();
  getTok(userId).tokens += def.tokens;
  saveStats();
  saveTokens();

  return def;
}

function achievementsSummary(userId) {
  const s = getStats(userId);
  const keys = Object.keys(s.achievements || {});
  if (!keys.length) return "`None yet.`";
  const names = keys
    .map((k) => Object.values(ACH).find((a) => a.key === k)?.name)
    .filter(Boolean);
  return names.length ? names.map((n) => `• ${n}`).join("\n") : "`None yet.`";
}

// ================== CINEMATIC LAUNCH ==================
async function cinematicLaunch(interaction, title) {
  await interaction.reply({ content: `🌀 ${title}`, ephemeral: true });
  for (const line of CINEMATIC) {
    await new Promise((r) => setTimeout(r, 520));
    await interaction.editReply({ content: line });
  }
  await new Promise((r) => setTimeout(r, 520));
  await interaction.editReply({ content: "🏁 **LAUNCH!**" });
}

// ================== SOLO RACE ==================
const activeSoloRace = new Set();
const activeSoloRaceByGuild = new Map(); // guildId -> count
async function runSoloRace(interaction, colourKey, tierKey) {
  if (settings.freezeRaces) {
    return interaction.reply({ content: "🛠️ Maintenance mode — check back soon.", ephemeral: true });
  }

  seasonCheckAndResetIfNeeded();

  // Anti-spam cap per guild
  const guildId = interaction.guildId;
  const activeInGuild = activeSoloRaceByGuild.get(guildId) || 0;
  if (activeInGuild >= MAX_ACTIVE_SOLO_RACES_PER_GUILD) {
    return interaction.reply({
      content: "🚦 Too many solo races running right now — try again in a minute.",
      ephemeral: true,
    });
  }

  const userId = interaction.user.id;
  const cdLeft = onCooldown(lastSoloPlay, userId, SOLO_COOLDOWN_SEC);
  if (cdLeft)
    return interaction.reply({
      content: `⏳ Cooldown active. Try again <t:${nowSec() + cdLeft}:R>.`,
      ephemeral: true,
    });

  if (activeSoloRace.has(userId)) {
    return interaction.reply({
      content: "⏳ You already have a race running. Wait for it to finish.",
      ephemeral: true,
    });
  }

  const tier = TIERS[tierKey] || TIERS.standard;
  const tokenCost = tier.tokenCost;

  const u = getTok(userId);
  if (u.tokens < tokenCost) {
    return interaction.reply({
      content: `❌ You need **${tokenCost} token(s)** for **${tier.label}** tier.\nUse \`/tokens daily\` or ask staff.`,
      ephemeral: true,
    });
  }

  u.tokens -= tokenCost;
  saveTokens();

  const st = getStats(userId);
  st.races += 1;
  saveStats();

  activeSoloRace.add(userId);
  activeSoloRaceByGuild.set(guildId, activeInGuild + 1);
  setCooldown(lastSoloPlay, userId);

  const bet = COLOUR_BY_KEY.get(colourKey) || COLOUR_BY_KEY.get("red");

  // Seeded RNG per race
  const seed = newSeed();
  const rng = makeRng(seed);

  // Audit: log seed
  await auditLog(
    interaction.guild,
    new EmbedBuilder()
      .setColor(COLOR_NEUTRAL)
      .setTitle(`🎲 Audit • SOLO RNG Seed • Season #${statsDB.meta.seasonNumber}`)
      .addFields(
        { name: "Player", value: `${tag(userId)} (${userId})`, inline: false },
        { name: "Tier", value: `${tier.emoji} ${tier.label}`, inline: true },
        { name: "Seed", value: `${seed}`, inline: true }
      )
      .setFooter({ text: FOOTER })
  );

  const racers = COLOURS.map((c) => ({
    ...c,
    pos: 0,
    finished: false,
    finishTick: null,
    lastEvent: null,
  }));

  let finishedCount = 0;
  let tick = 0;
  let raceFinalized = false;

  await cinematicLaunch(interaction, `Solo race loading… (${tier.emoji} ${tier.label})`);

  const msg = await interaction.followUp({
    embeds: [
      new EmbedBuilder()
        .setColor(COLOR_PRIMARY)
        .setTitle(`🏇 ${BRAND} — SOLO RHIB RACE`)
        .setDescription(
          `${header("BET LOCKED")}\n\n` +
            `👤 **Racer:** ${tag(userId)}\n` +
            `🎯 **RHIB:** ${bet.label}\n` +
            `${tier.emoji} **Tier:** ${tier.label}\n` +
            `🎟️ **Entry:** \`${tokenCost}\` • **Tokens left:** \`${getTok(userId).tokens}\`\n\n` +
            `💰 **Winnings:**\n${payoutTableText(tier)}`
        )
        .setFooter({ text: FOOTER }),
    ],
    fetchReply: true,
  });

  let lastFrameKey = ""; // edit throttle: only edit if content changed

  const interval = setInterval(async () => {
    try {
      if (raceFinalized) return;
      tick++;

      const order = racers.slice().sort((a, b) => b.pos - a.pos);
      const rankMap = new Map(order.map((r, i) => [r.key, i]));

      const rhibEmoji = getRhibEmoji(interaction.guild);
      const commentary = rng() < 0.18 ? rand(COMMENTARY, rng) : null;

      for (const r of racers) {
        if (r.finished) continue;

        let step = rollBaseStep(rng);

        const ev = maybeEvent(rng);
        r.lastEvent = ev ? ev.text : null;

        if (ev?.kind === "BOOST") step += 1;
        if (ev?.kind === "STALL") step = Math.max(0, step - 1);

        const rk = rankMap.get(r.key) ?? 2;
        step += houseEdgeModifier(rk, racers.length, tier.key, rng);
        step += finalSprintBoost(r.pos, rng);

        if (r.key === bet.key) {
          step += streakPenalty(st.winStreak, tier.key, rng);
        }

        step = Math.max(0, Math.min(3, step));
        r.pos += step;

        if (r.pos >= TRACK_LEN) {
          r.pos = TRACK_LEN - 1;
          r.finished = true;
          r.finishTick = tick;
          finishedCount++;
        }
      }

      let places = [];
      if (finishedCount === racers.length) {
        places = racers
          .slice()
          .sort((a, b) => a.finishTick - b.finishTick || b.pos - a.pos)
          .map((r, i) => ({ ...r, place: i + 1 }));
      }

      const lines = (places.length ? places : racers).map((r) => {
        const badge = places.length ? placeBadge(r.place) : `(${pct(r.pos)}%)`;
        return renderLine(r, r.pos, badge, rhibEmoji);
      });

      const comms = racers
        .filter((r) => r.lastEvent)
        .slice(0, 2)
        .map((r) => `${r.label} ${r.lastEvent}`)
        .join("\n");

      // Edit-throttle key
      const frameKey = `${lines.join("|")}__${comms}__${commentary || ""}`;
      if (frameKey !== lastFrameKey) {
        lastFrameKey = frameKey;
        await msg
          .edit({
            embeds: [
              new EmbedBuilder()
                .setColor(COLOR_ACCENT)
                .setTitle(`🏁 ${BRAND} — LIVE TRACK FEED`)
                .setDescription(
                  `${header("SOLO LIVE")}\n\n` +
                    `👤 **Racer:** ${tag(userId)} • 🎯 **RHIB:** ${bet.label}\n` +
                    `${tier.emoji} **Tier:** ${tier.label}\n\n` +
                    `🏁 **Track:**\n${lines.join("\n")}\n\n` +
                    `📡 **Comms:**\n${comms || "`Seas are calm…`"}\n` +
                    (commentary ? `\n${commentary}` : "")
                )
                .setFooter({ text: FOOTER }),
            ],
          })
          .catch(() => {});
      }

      if (places.length && !raceFinalized) {
        raceFinalized = true;
        clearInterval(interval);

        const your = places.find((r) => r.key === bet.key);
        const truePlace = your.place;
        const winnings = tier.payouts[truePlace] || 0;

        const photoFinish = places[0].finishTick === places[1].finishTick;

        if (truePlace === 1) {
          st.winStreak = (st.winStreak || 0) + 1;
          st.bestWinStreak = Math.max(st.bestWinStreak || 0, st.winStreak);
        } else {
          st.winStreak = 0;
        }

        st.bestFinish = Math.min(st.bestFinish, truePlace);
        if (truePlace === 1) st.wins += 1;
        if (truePlace <= 3) st.podiums += 1;
        st.totalWon += winnings;
        saveStats();

        const awarded = [];
        if (st.races === 1) {
          const a = awardAchievement(userId, ACH.FIRST_RACE.key);
          if (a) awarded.push(a);
        }
        if (truePlace === 1) {
          const a = awardAchievement(userId, ACH.FIRST_WIN.key);
          if (a) awarded.push(a);
        }
        if (photoFinish) {
          const a = awardAchievement(userId, ACH.PHOTO_FINISH.key);
          if (a) awarded.push(a);
        }
        if ((st.winStreak || 0) >= 3) {
          const a = awardAchievement(userId, ACH.STREAK_3.key);
          if (a) awarded.push(a);
        }
        if ((st.podiums || 0) >= 5) {
          const a = awardAchievement(userId, ACH.PODIUM_5.key);
          if (a) awarded.push(a);
        }

        if (winnings > 0 && !settings.freezePayouts) {
          await enqueuePayout(interaction.guild, userId, winnings);
        }

        // placements emoji-only
        const results = places.map((p) => `${placeBadge(p.place)} ${p.label}`).join("\n");

        const resultLine =
          winnings > 0
            ? `🎉 ${tag(userId)} your ${bet.label} finished **${placeBadge(truePlace)}**!\n✅ Kaos payout queued: **${winnings.toLocaleString()} ${CURRENCY_NAME}**`
            : `😢 ${tag(userId)} your ${bet.label} finished **${placeBadge(truePlace)}**.\nNo payout this time.`;

        // clean achievements heading + grammar
        const achBlock = awarded.length
          ? `\n\n🏅 **Achievements unlocked:**\n${awarded
              .map((a) => `• **${a.name}** (+${a.tokens} ${a.tokens === 1 ? "token" : "tokens"})`)
              .join("\n")}`
          : "";

        await msg
          .reply({
            embeds: [
              new EmbedBuilder()
                .setColor(winnings > 0 ? COLOR_PRIMARY : COLOR_DARK)
                .setTitle(`🏆 ${BRAND} — SOLO RESULT`)
                .setDescription(
                  `${header("RACE COMPLETE")}\n\n` +
                    `${resultLine}\n` +
                    (photoFinish ? `\n📸 **PHOTO FINISH!** VAR called.\n` : "\n") +
                    `**Placements:**\n${results}` +
                    achBlock
                )
                .setFooter({ text: FOOTER }),
            ],
          })
          .catch(() => {});

        await auditLog(
          interaction.guild,
          new EmbedBuilder()
            .setColor(COLOR_NEUTRAL)
            .setTitle(`🧾 Audit • SOLO • Season #${statsDB.meta.seasonNumber}`)
            .addFields(
              { name: "Player", value: `${tag(userId)} (${userId})`, inline: false },
              { name: "Tier", value: `${tier.emoji} ${tier.label} (cost ${tier.tokenCost})`, inline: true },
              { name: "RHIB", value: `${bet.label}`, inline: true },
              { name: "Finish", value: `${placeBadge(truePlace)} (${truePlace})`, inline: true },
              {
                name: "Payout",
                value: settings.freezePayouts ? "FROZEN" : `${winnings.toLocaleString()} ${CURRENCY_NAME}`,
                inline: true,
              },
              { name: "Win Streak", value: `${st.winStreak || 0}`, inline: true },
              { name: "Seed", value: `${seed}`, inline: true }
            )
            .setFooter({ text: FOOTER })
        );
      }
    } catch (e) {
      raceFinalized = true;
      clearInterval(interval);
      console.log("Solo race error:", e?.message || e);
    } finally {
      if (raceFinalized) {
        activeSoloRace.delete(userId);
        const cur = activeSoloRaceByGuild.get(guildId) || 0;
        activeSoloRaceByGuild.set(guildId, Math.max(0, cur - 1));
      }
    }
  }, TICK_MS);
}
// ================== PARTY ==================
const partyByGuild = new Map();

function makeParty(hostId, channelId, tierKey) {
  return {
    hostId,
    createdAt: nowSec(),
    state: "LOBBY",
    finalized: false,
    players: new Map(), // uid -> { colourKey }
    messageId: null,
    channelId,
    tierKey: tierKey || "standard",
    autoStartTimeout: null,
    seed: newSeed(),
  };
}

function colourTaken(party, colourKey) {
  for (const p of party.players.values()) if (p.colourKey === colourKey) return true;
  return false;
}

async function getPartyMessage(guild, party) {
  if (!party.channelId || !party.messageId) return { channel: null, message: null };

  const channel = await guild.channels.fetch(party.channelId).catch(() => null);
  if (!channel || !("messages" in channel)) return { channel: null, message: null };

  const message = await channel.messages.fetch(party.messageId).catch(() => null);
  return { channel, message };
}

async function editOrPostPartyEmbed(interaction, party) {
  const tier = TIERS[party.tierKey] || TIERS.standard;

  // lineup emoji-only + host crown + slots left
  const lineup = Array.from(party.players.entries()).map(([uid, p]) => {
    const c = COLOUR_BY_KEY.get(p.colourKey);
    const crown = uid === party.hostId ? " 👑" : "";
    return `${c.label} ${tag(uid)}${crown}`;
  });

  const timeLeft = Math.max(0, party.createdAt + 60 - nowSec());
  const autoLine = party.state === "LOBBY" ? `⏱️ **Auto-start:** <t:${nowSec() + timeLeft}:R>` : "";
  const slotsLeft = Math.max(0, 5 - party.players.size);

  const desc =
    `${header("PARTY LOBBY — UNIQUE COLOURS")}\n\n` +
    `👑 **Host:** ${tag(party.hostId)}\n` +
    `${tier.emoji} **Tier:** ${tier.label} • Entry: **${tier.tokenCost} token(s)**\n` +
    `👥 **Players:** \`${party.players.size}\` / 5 • **Slots left:** \`${slotsLeft}\`\n` +
    `${autoLine}\n\n` +
    `**Line-up:**\n${lineup.length ? lineup.join("\n") : "`No racers yet.`"}\n\n` +
    `✅ **Join:** \`/raceparty join colour:<colour>\`\n` +
    `🚪 **Leave:** \`/raceparty leave\`\n` +
    `🏁 **Start now:** \`/raceparty start\` (host)\n` +
    `🧹 **Cancel:** \`/raceparty cancel\` (host)`;

  const e = new EmbedBuilder()
    .setColor(COLOR_ACCENT)
    .setTitle(`🏟️ ${BRAND} — PARTY RHIB RACE`)
    .setDescription(desc)
    .setFooter({ text: FOOTER });

  if (!party.messageId) {
    const msg = await interaction.reply({ embeds: [e], fetchReply: true });
    party.messageId = msg.id;
    party.channelId = interaction.channelId;
    return;
  }

  const { message } = await getPartyMessage(interaction.guild, party);
  if (message) await message.edit({ embeds: [e] }).catch(() => {});
}

async function cancelParty(guild, party, reason) {
  const { message } = await getPartyMessage(guild, party);
  const e = new EmbedBuilder()
    .setColor(COLOR_DARK)
    .setTitle(`🧹 ${BRAND} — PARTY CLOSED`)
    .setDescription(`${header("LOBBY ENDED")}\n\n${reason}`)
    .setFooter({ text: FOOTER });

  if (message) await message.edit({ embeds: [e] }).catch(() => {});
  if (party.autoStartTimeout) clearTimeout(party.autoStartTimeout);
  partyByGuild.delete(guild.id);
}

async function runPartyRace(guild, party) {
  if (settings.freezeRaces) return;
  seasonCheckAndResetIfNeeded();

  if (party.state !== "LOBBY" || party.finalized) return;

  const tier = TIERS[party.tierKey] || TIERS.standard;

  if (party.players.size < 2) {
    await cancelParty(guild, party, "Not enough racers joined in time. (Need **2+** to start)");
    return;
  }

  // seeded RNG for party race
  const seed = party.seed || newSeed();
  const rng = makeRng(seed);

  // Audit: log seed (party)
  await auditLog(
    guild,
    new EmbedBuilder()
      .setColor(COLOR_NEUTRAL)
      .setTitle(`🎲 Audit • PARTY RNG Seed • Season #${statsDB.meta.seasonNumber}`)
      .addFields(
        { name: "Host", value: `${tag(party.hostId)} (${party.hostId})`, inline: false },
        { name: "Tier", value: `${tier.emoji} ${tier.label}`, inline: true },
        { name: "Seed", value: `${seed}`, inline: true }
      )
      .setFooter({ text: FOOTER })
  );

  // re-check everyone at start (still important)
  for (const uid of party.players.keys()) {
    const left = onCooldown(lastPartyPlay, uid, PARTY_COOLDOWN_SEC);
    if (left) {
      await cancelParty(guild, party, "Someone was on cooldown. Try again later.");
      return;
    }
    if (getTok(uid).tokens < tier.tokenCost) {
      await cancelParty(guild, party, `Someone did not have enough tokens for **${tier.label}** tier.`);
      return;
    }
  }

  for (const uid of party.players.keys()) {
    getTok(uid).tokens -= tier.tokenCost;
    setCooldown(lastPartyPlay, uid);
    getStats(uid).races += 1;
  }
  saveTokens();
  saveStats();

  party.state = "RUNNING";
  if (party.autoStartTimeout) clearTimeout(party.autoStartTimeout);

  let { channel: lobbyChannel, message: lobbyMsg } = await getPartyMessage(guild, party);

  if (!lobbyChannel) {
    lobbyChannel = await guild.channels.fetch(party.channelId).catch(() => null);
  }
  if (lobbyChannel && !lobbyMsg) {
    const created = await lobbyChannel
      .send({
        embeds: [
          new EmbedBuilder()
            .setColor(COLOR_PRIMARY)
            .setTitle(`🏁 ${BRAND} — PARTY LIVE TRACK FEED`)
            .setDescription(`${header("MULTIPLAYER LIVE")}\n\n(Starting...)`)
            .setFooter({ text: FOOTER }),
        ],
      })
      .catch(() => null);

    if (created) {
      party.messageId = created.id;
      lobbyMsg = created;
    }
  }

  if (lobbyMsg) {
    const cin = new EmbedBuilder()
      .setColor(COLOR_NEUTRAL)
      .setTitle(`🎬 ${BRAND} — Race Cinematic`)
      .setDescription(`${CINEMATIC.join("\n")}\n\n🏁 **LAUNCH!**`)
      .setFooter({ text: FOOTER });

    await lobbyMsg.edit({ embeds: [cin] }).catch(() => {});
    await new Promise((r) => setTimeout(r, 900));
  }

  const racers = COLOURS.map((c) => ({
    ...c,
    pos: 0,
    finished: false,
    finishTick: null,
    lastEvent: null,
  }));

  let finishedCount = 0;
  let tick = 0;
  let lastFrameKey = "";

  const interval = setInterval(async () => {
    try {
      if (party.finalized) return;

      tick++;

      const order = racers.slice().sort((a, b) => b.pos - a.pos);
      const rankMap = new Map(order.map((r, i) => [r.key, i]));

      const rhibEmoji = getRhibEmoji(guild);
      const commentary = rng() < 0.2 ? rand(COMMENTARY, rng) : null;

      for (const r of racers) {
        if (r.finished) continue;

        let step = rollBaseStep(rng);

        const ev = maybeEvent(rng);
        r.lastEvent = ev ? ev.text : null;

        if (ev?.kind === "BOOST") step += 1;
        if (ev?.kind === "STALL") step = Math.max(0, step - 1);

        const rk = rankMap.get(r.key) ?? 2;
        step += houseEdgeModifier(rk, racers.length, tier.key, rng);
        step += finalSprintBoost(r.pos, rng);

        // streak penalty for the player who chose this colour
        const playerEntry = Array.from(party.players.entries()).find(([, p]) => p.colourKey === r.key);
        if (playerEntry) {
          const [uid] = playerEntry;
          const s = getStats(uid);
          step += streakPenalty(s.winStreak, tier.key, rng);
        }

        step = Math.max(0, Math.min(3, step));
        r.pos += step;

        if (r.pos >= TRACK_LEN) {
          r.pos = TRACK_LEN - 1;
          r.finished = true;
          r.finishTick = tick;
          finishedCount++;
        }
      }

      let places = [];
      if (finishedCount === racers.length) {
        places = racers
          .slice()
          .sort((a, b) => a.finishTick - b.finishTick || b.pos - a.pos)
          .map((r, i) => ({ ...r, place: i + 1 }));
      }

      const lines = (places.length ? places : racers).map((r) => {
        const badge = places.length ? placeBadge(r.place) : `(${pct(r.pos)}%)`;
        return renderLine(r, r.pos, badge, rhibEmoji);
      });

      const lineup = Array.from(party.players.entries())
        .map(([uid, p]) => {
          const c = COLOUR_BY_KEY.get(p.colourKey);
          const crown = uid === party.hostId ? " 👑" : "";
          return `${c.label} ${tag(uid)}${crown}`;
        })
        .join("\n");

      const comms = racers
        .filter((r) => r.lastEvent)
        .slice(0, 2)
        .map((r) => `${r.label} ${r.lastEvent}`)
        .join("\n");

      const frameKey = `${lines.join("|")}__${lineup}__${comms}__${commentary || ""}`;
      if (lobbyMsg && frameKey !== lastFrameKey) {
        lastFrameKey = frameKey;

        const e = new EmbedBuilder()
          .setColor(COLOR_PRIMARY)
          .setTitle(`🏁 ${BRAND} — PARTY LIVE TRACK FEED`)
          .setDescription(
            `${header("MULTIPLAYER LIVE")}\n\n` +
              `${tier.emoji} **Tier:** ${tier.label}\n\n` +
              `**Line-up:**\n${lineup}\n\n` +
              `🏁 **Track:**\n${lines.join("\n")}\n\n` +
              `📡 **Comms:**\n${comms || "`Engines roaring…`"}\n` +
              (commentary ? `\n${commentary}` : "")
          )
          .setFooter({ text: FOOTER });

        await lobbyMsg.edit({ embeds: [e] }).catch(() => {});
      }

      if (places.length && !party.finalized) {
        party.finalized = true;
        clearInterval(interval);

        const photoFinish = places[0].finishTick === places[1].finishTick;
        const placeByKey = new Map(places.map((p) => [p.key, p.place]));

        const placementSummary = [];
        const payoutSummary = [];
        const auditPayoutLines = [];
        const awardedLines = [];

        for (const [uid, p] of party.players.entries()) {
          const truePlace = placeByKey.get(p.colourKey);
          const amount = tier.payouts[truePlace] || 0;
          const c = COLOUR_BY_KEY.get(p.colourKey);
          const s = getStats(uid);

          if (truePlace === 1) {
            s.winStreak = (s.winStreak || 0) + 1;
            s.bestWinStreak = Math.max(s.bestWinStreak || 0, s.winStreak);
          } else {
            s.winStreak = 0;
          }

          s.bestFinish = Math.min(s.bestFinish, truePlace);
          if (truePlace === 1) s.wins += 1;
          if (truePlace <= 3) s.podiums += 1;
          s.totalWon += amount;

          // achievements
          const got = [];
          if (s.races === 1) {
            const a = awardAchievement(uid, ACH.FIRST_RACE.key);
            if (a) got.push(a);
          }
          if (truePlace === 1) {
            const a = awardAchievement(uid, ACH.FIRST_WIN.key);
            if (a) got.push(a);
            const b = awardAchievement(uid, ACH.PARTY_WIN.key);
            if (b) got.push(b);
          }
          if (photoFinish) {
            const a = awardAchievement(uid, ACH.PHOTO_FINISH.key);
            if (a) got.push(a);
          }
          if ((s.winStreak || 0) >= 3) {
            const a = awardAchievement(uid, ACH.STREAK_3.key);
            if (a) got.push(a);
          }
          if ((s.podiums || 0) >= 5) {
            const a = awardAchievement(uid, ACH.PODIUM_5.key);
            if (a) got.push(a);
          }

          if (got.length) {
            awardedLines.push(
              `${c.label} ${tag(uid)}: ${got
                .map((a) => `**${a.name}** (+${a.tokens} ${a.tokens === 1 ? "token" : "tokens"})`)
                .join(", ")}`
            );
          }

          if (amount > 0 && !settings.freezePayouts) {
            await enqueuePayout(guild, uid, amount);
          }

          placementSummary.push(`${placeBadge(truePlace)} ${c.label} ${tag(uid)}`);
          payoutSummary.push(`${c.label} ${tag(uid)} → **${amount.toLocaleString()} ${CURRENCY_NAME}**`);
          auditPayoutLines.push(`${uid}:${amount}`);
        }

        saveStats();

        const endEmbed = new EmbedBuilder()
          .setColor(COLOR_ACCENT)
          .setTitle(`🏆 ${BRAND} — PARTY RESULTS`)
          .setDescription(
            `${header("RACE COMPLETE")}\n\n` +
              `${tier.emoji} **Tier:** ${tier.label}\n` +
              (photoFinish ? `📸 **PHOTO FINISH!** VAR called.\n\n` : "\n") +
              `**Placements:**\n${placementSummary.join("\n")}\n\n` +
              `**Payouts (Kaos queued):**\n${payoutSummary.join("\n")}\n` +
              (awardedLines.length ? `\n🏅 **Achievements:**\n${awardedLines.join("\n")}\n` : "\n") +
              `Create a new lobby with \`/raceparty create\`.`
          )
          .setFooter({ text: FOOTER });

        if (lobbyMsg) await lobbyMsg.edit({ embeds: [endEmbed] }).catch(() => {});

        await auditLog(
          guild,
          new EmbedBuilder()
            .setColor(COLOR_NEUTRAL)
            .setTitle(`🧾 Audit • PARTY • Season #${statsDB.meta.seasonNumber}`)
            .addFields(
              { name: "Tier", value: `${tier.emoji} ${tier.label} (cost ${tier.tokenCost})`, inline: true },
              { name: "Host", value: `${tag(party.hostId)} (${party.hostId})`, inline: true },
              { name: "Players", value: `${party.players.size}`, inline: true },
              { name: "Seed", value: `${seed}`, inline: true },
              {
                name: "Payouts",
                value: settings.freezePayouts ? "FROZEN" : auditPayoutLines.join("\n") || "None",
                inline: false,
              }
            )
            .setFooter({ text: FOOTER })
        );

        partyByGuild.delete(guild.id);
      }
    } catch (e) {
      party.finalized = true;
      clearInterval(interval);
      partyByGuild.delete(guild.id);
      console.log("Party race error:", e?.message || e);
    }
  }, TICK_MS);
}

// ================== LEADERBOARDS ==================
function topBy(field, limit = 10) {
  const arr = Object.entries(statsDB.users).map(([uid, s]) => ({ uid, ...s }));
  arr.sort((a, b) => (b[field] || 0) - (a[field] || 0));
  return arr.slice(0, limit);
}

// Prevents currency showing twice on /top
function formatTop(arr, field, label) {
  if (!arr.length) return "`No data yet.`";
  return arr
    .map((x, i) => {
      const val = x[field] ?? 0;
      const shown = field === "totalWon" ? `${val.toLocaleString()} ${CURRENCY_NAME}` : `${val}`;
      const suffix = field === "totalWon" ? "" : ` ${label}`;
      return `**${i + 1}.** ${tag(x.uid)} — **${shown}**${suffix}`;
    })
    .join("\n");
}
/* ================== COMMANDS ================== */
const colourChoices = COLOURS.map((c) => ({ name: `${c.name} ${c.label}`, value: c.key }));
const tierChoices = [
  { name: `${TIERS.low.emoji} Low`, value: "low" },
  { name: `${TIERS.standard.emoji} Standard`, value: "standard" },
  { name: `${TIERS.high.emoji} High`, value: "high" },
];

const commands = [
  new SlashCommandBuilder()
    .setName("race")
    .setDescription("Solo RHIB race (pick a colour + tier).")
    .addStringOption((o) => o.setName("colour").setDescription("Pick your colour").setRequired(true).addChoices(...colourChoices))
    .addStringOption((o) => o.setName("tier").setDescription("Risk tier").setRequired(true).addChoices(...tierChoices)),

  new SlashCommandBuilder()
    .setName("raceparty")
    .setDescription("Multiplayer party race (auto-starts in 60s)")
    .addSubcommand((sc) =>
      sc
        .setName("create")
        .setDescription("Create a party lobby (auto-start in 60 seconds)")
        .addStringOption((o) => o.setName("tier").setDescription("Risk tier").setRequired(true).addChoices(...tierChoices))
        .addStringOption((o) => o.setName("colour").setDescription("Host colour").setRequired(true).addChoices(...colourChoices))
    )
    .addSubcommand((sc) =>
      sc
        .setName("join")
        .setDescription("Join the party (unique colour)")
        .addStringOption((o) => o.setName("colour").setDescription("Pick your colour").setRequired(true).addChoices(...colourChoices))
    )
    .addSubcommand((sc) => sc.setName("leave").setDescription("Leave the current party"))
    .addSubcommand((sc) => sc.setName("start").setDescription("Start the party race now (host only)"))
    .addSubcommand((sc) => sc.setName("cancel").setDescription("Cancel the party lobby (host only)")),

  new SlashCommandBuilder().setName("racehelp").setDescription("How RHIB Racing works"),
  new SlashCommandBuilder().setName("balance").setDescription("Check your token balance"),
  new SlashCommandBuilder().setName("racestats").setDescription("Your racing stats"),
  new SlashCommandBuilder().setName("top").setDescription("Top 10 by total winnings"),
  new SlashCommandBuilder().setName("topwins").setDescription("Top 10 by wins"),

  new SlashCommandBuilder()
    .setName("tokens")
    .setDescription("Token system for RHIB Racing")
    .addSubcommand((sc) => sc.setName("balance").setDescription("Check your token balance"))
    .addSubcommand((sc) => sc.setName("daily").setDescription("Claim your daily free token"))
    .addSubcommand((sc) =>
      sc
        .setName("transfer")
        .setDescription("Transfer tokens to another player")
        .addUserOption((o) => o.setName("to").setDescription("Recipient").setRequired(true))
        .addIntegerOption((o) => o.setName("amount").setDescription("Amount").setRequired(true).setMinValue(1).setMaxValue(1000))
    )
    .addSubcommand((sc) =>
      sc
        .setName("give")
        .setDescription("Give tokens to a user (admin)")
        .addUserOption((o) => o.setName("user").setDescription("User").setRequired(true))
        .addIntegerOption((o) => o.setName("amount").setDescription("Amount").setRequired(true).setMinValue(1).setMaxValue(1000))
    )
    .addSubcommand((sc) =>
      sc
        .setName("giveall")
        .setDescription("Give tokens to everyone (admin)")
        .addIntegerOption((o) => o.setName("amount").setDescription("Amount each").setRequired(true).setMinValue(1).setMaxValue(50))
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("raceadmin")
    .setDescription("Admin controls")
    .addSubcommand((sc) => sc.setName("freeze-races-on").setDescription("Freeze all races (admin)"))
    .addSubcommand((sc) => sc.setName("freeze-races-off").setDescription("Unfreeze races (admin)"))
    .addSubcommand((sc) => sc.setName("freeze-payouts-on").setDescription("Freeze Kaos payouts (admin)"))
    .addSubcommand((sc) => sc.setName("freeze-payouts-off").setDescription("Unfreeze Kaos payouts (admin)"))
    .addSubcommand((sc) => sc.setName("season-reset").setDescription("Reset season stats now (admin)"))
    .addSubcommand((sc) => sc.setName("season-info").setDescription("Show current season info (admin)"))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
].map((c) => c.toJSON());

// ================== DEPLOY ==================
async function deployCommandsServerOnly() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log("✅ Server-only commands deployed.");
}

// ================== CLIENT ==================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

client.once("ready", async () => {
  ensureDataFiles();
  seasonCheckAndResetIfNeeded();
  console.log(`✅ Online as ${client.user.tag}`);
  console.log(`Season #${statsDB.meta.seasonNumber} started: ${new Date(statsDB.meta.seasonStart).toISOString()}`);

  // intent sanity check (giveall needs member fetch)
  try {
    const g = await client.guilds.fetch(GUILD_ID);
    await g.members.fetch({ limit: 1 });
  } catch {
    console.log(
      "⚠️ Warning: member fetch failed. If /tokens giveall fails, enable SERVER MEMBERS INTENT in the Discord Developer Portal."
    );
  }
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;

    // permission sanity check for visible commands
    if (interaction.channel && interaction.guild) {
      const me = interaction.guild.members.me;
      if (me) {
        const miss = missingPerms(interaction.channel, me);
        if (miss.length && miss[0] !== "Unknown") {
          return interaction.reply({
            content: `❌ I’m missing permissions in this channel: **${miss.join(", ")}**`,
            ephemeral: true,
          });
        }
      }
    }

    if (interaction.commandName === "racehelp") {
      return interaction.reply({ embeds: [buildHelpEmbed()], ephemeral: true });
    }

    if (interaction.commandName === "balance") {
      const me = getTok(interaction.user.id);
      return interaction.reply({
        content: `🎟️ **Race Tokens:** ${me.tokens}\n💰 **${CURRENCY_NAME}:** Managed by Kaos (this bot only triggers payouts).`,
        ephemeral: true,
      });
    }

    if (interaction.commandName === "racestats") {
      seasonCheckAndResetIfNeeded();
      const s = getStats(interaction.user.id);
      const best = s.bestFinish === 99 ? "—" : `#${s.bestFinish}`;

      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(COLOR_NEUTRAL)
            .setTitle(`📊 ${BRAND} — Your Stats (Season #${statsDB.meta.seasonNumber})`)
            .addFields(
              { name: "Races", value: `**${s.races}**`, inline: true },
              { name: "Wins", value: `**${s.wins}**`, inline: true },
              { name: "Podiums", value: `**${s.podiums}**`, inline: true },
              { name: "Best Finish", value: `**${best}**`, inline: true },
              { name: "Win Streak", value: `**${s.winStreak || 0}** (best ${s.bestWinStreak || 0})`, inline: true },
              { name: `Total Won (${CURRENCY_NAME})`, value: `**${s.totalWon.toLocaleString()}**`, inline: true },
              { name: "Tokens", value: `**${getTok(interaction.user.id).tokens}**`, inline: true },
              { name: "Achievements", value: achievementsSummary(interaction.user.id), inline: false }
            )
            .setFooter({ text: FOOTER }),
        ],
        ephemeral: true,
      });
    }

    if (interaction.commandName === "top") {
      seasonCheckAndResetIfNeeded();
      const top = topBy("totalWon", 10);
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(COLOR_ACCENT)
            .setTitle(`🏆 ${BRAND} — Top Winnings (Season #${statsDB.meta.seasonNumber})`)
            .setDescription(formatTop(top, "totalWon", CURRENCY_NAME))
            .setFooter({ text: FOOTER }),
        ],
      });
    }

    if (interaction.commandName === "topwins") {
      seasonCheckAndResetIfNeeded();
      const top = topBy("wins", 10);
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(COLOR_PRIMARY)
            .setTitle(`🥇 ${BRAND} — Top Wins (Season #${statsDB.meta.seasonNumber})`)
            .setDescription(formatTop(top, "wins", "wins"))
            .setFooter({ text: FOOTER }),
        ],
      });
    }

    if (interaction.commandName === "race") {
      const colourKey = interaction.options.getString("colour", true);
      const tierKey = interaction.options.getString("tier", true);
      return runSoloRace(interaction, colourKey, tierKey);
    }

    if (interaction.commandName === "raceparty") {
      const sub = interaction.options.getSubcommand();
      const guildId = interaction.guildId;

      if (sub === "create") {
        if (settings.freezeRaces) {
          return interaction.reply({ content: "🛠️ Maintenance mode — check back soon.", ephemeral: true });
        }

        if (partyByGuild.has(guildId)) {
          return interaction.reply({ content: "A party lobby already exists. Use `/raceparty join`.", ephemeral: true });
        }

        const tierKey = interaction.options.getString("tier", true);
        const colourKey = interaction.options.getString("colour", true);
        const tier = TIERS[tierKey] || TIERS.standard;

        // block create if host on cooldown
        const hostLeft = onCooldown(lastPartyPlay, interaction.user.id, PARTY_COOLDOWN_SEC);
        if (hostLeft) {
          return interaction.reply({
            content: `⏳ You’re on party cooldown. Try again <t:${nowSec() + hostLeft}:R>.`,
            ephemeral: true,
          });
        }

        // block create if host lacks tokens
        if (getTok(interaction.user.id).tokens < tier.tokenCost) {
          return interaction.reply({
            content: `❌ You need **${tier.tokenCost} token(s)** to create a **${tier.label}** party.`,
            ephemeral: true,
          });
        }

        const party = makeParty(interaction.user.id, interaction.channelId, tierKey);

        // host auto-joins with chosen colour
        party.players.set(interaction.user.id, { colourKey });

        partyByGuild.set(guildId, party);

        // optional ping once
        const ping = pingRoleText();
        if (ping && interaction.channel?.send) {
          await interaction.channel.send({ content: `🏟️ Party lobby created! ${ping}` }).catch(() => {});
        }

        await editOrPostPartyEmbed(interaction, party);

        // auto start
        party.autoStartTimeout = setTimeout(async () => {
          try {
            const p = partyByGuild.get(guildId);
            if (!p) return;
            await runPartyRace(interaction.guild, p);
          } catch {}
        }, 60_000);

        return;
      }

      const party = partyByGuild.get(guildId);
      if (!party) {
        return interaction.reply({ content: "No active party lobby. Create one with `/raceparty create`.", ephemeral: true });
      }

      const tier = TIERS[party.tierKey] || TIERS.standard;

      if (sub === "join") {
        if (party.state !== "LOBBY") return interaction.reply({ content: "Party is already running.", ephemeral: true });

        // block join if user on cooldown
        const left = onCooldown(lastPartyPlay, interaction.user.id, PARTY_COOLDOWN_SEC);
        if (left) {
          return interaction.reply({
            content: `⏳ You’re on party cooldown. Try again <t:${nowSec() + left}:R>.`,
            ephemeral: true,
          });
        }

        // block join if user lacks tokens for this tier
        if (getTok(interaction.user.id).tokens < tier.tokenCost) {
          return interaction.reply({
            content: `❌ You need **${tier.tokenCost} token(s)** to join this **${tier.label}** party.`,
            ephemeral: true,
          });
        }

        const colourKey = interaction.options.getString("colour", true);

        if (colourTaken(party, colourKey)) {
          const c = COLOUR_BY_KEY.get(colourKey);
          return interaction.reply({ content: `❌ Colour taken: ${c.label}`, ephemeral: true });
        }

        if (party.players.size >= 5 && !party.players.has(interaction.user.id)) {
          return interaction.reply({ content: "Party is full (max 5).", ephemeral: true });
        }

        party.players.set(interaction.user.id, { colourKey });

        const c = COLOUR_BY_KEY.get(colourKey);
        await interaction.reply({ content: `✅ Joined as ${c.label}`, ephemeral: true });
        await editOrPostPartyEmbed(interaction, party);
        return;
      }

      if (sub === "leave") {
        if (!party.players.has(interaction.user.id)) {
          return interaction.reply({ content: "You’re not in the party.", ephemeral: true });
        }
        party.players.delete(interaction.user.id);

        if (interaction.user.id === party.hostId) {
          await cancelParty(interaction.guild, party, "Host left — party lobby closed.");
          return interaction.reply({ content: "Host left — party lobby closed.", ephemeral: true });
        }

        await interaction.reply({ content: "✅ Left the party.", ephemeral: true });
        await editOrPostPartyEmbed(interaction, party);
        return;
      }

      if (sub === "cancel") {
        if (interaction.user.id !== party.hostId) return interaction.reply({ content: "Only host can cancel.", ephemeral: true });
        await cancelParty(interaction.guild, party, "Cancelled by host.");
        return interaction.reply({ content: "🧹 Party cancelled.", ephemeral: true });
      }

      if (sub === "start") {
        if (interaction.user.id !== party.hostId) return interaction.reply({ content: "Only host can start.", ephemeral: true });
        await interaction.reply({ content: "🏁 Starting party race now…", ephemeral: true });
        await runPartyRace(interaction.guild, party);
        return;
      }
    }

    if (interaction.commandName === "tokens") {
      const sub = interaction.options.getSubcommand();
      const me = getTok(interaction.user.id);

      if (sub === "balance") return interaction.reply({ content: `🎟️ Tokens: **${me.tokens}**`, ephemeral: true });

      if (sub === "daily") {
        const now = nowSec();
        const day = 24 * 60 * 60;
        const left = me.lastDaily + day - now;
        if (left > 0) return interaction.reply({ content: `⏳ Try again <t:${me.lastDaily + day}:R>.`, ephemeral: true });

        me.tokens += DAILY_TOKENS;
        me.lastDaily = now;
        saveTokens();
        return interaction.reply({ content: `✅ Claimed **${DAILY_TOKENS}** token. Balance: **${me.tokens}**`, ephemeral: true });
      }

      if (sub === "transfer") {
        const to = interaction.options.getUser("to", true);
        const amt = interaction.options.getInteger("amount", true);
        if (to.bot) return interaction.reply({ content: "❌ Can't transfer to bots.", ephemeral: true });
        if (me.tokens < amt) return interaction.reply({ content: `❌ You have **${me.tokens}** tokens.`, ephemeral: true });

        getTok(to.id).tokens += amt;
        me.tokens -= amt;
        saveTokens();
        return interaction.reply({ content: `✅ Sent **${amt}** tokens to ${tag(to.id)}.`, ephemeral: true });
      }

      const isAdmin = interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);

      if (sub === "give") {
        if (!isAdmin) return interaction.reply({ content: "❌ Admin only.", ephemeral: true });
        const user = interaction.options.getUser("user", true);
        const amt = interaction.options.getInteger("amount", true);
        getTok(user.id).tokens += amt;
        saveTokens();
        return interaction.reply({ content: `✅ Gave **${amt}** tokens to ${tag(user.id)}.`, ephemeral: true });
      }

      if (sub === "giveall") {
        if (!isAdmin) return interaction.reply({ content: "❌ Admin only.", ephemeral: true });
        const amt = interaction.options.getInteger("amount", true);

        await interaction.reply({ content: `Giving **${amt}** tokens to everyone…`, ephemeral: true });

        const members = await interaction.guild.members.fetch({ withPresences: false }).catch(() => null);
        if (!members) return interaction.followUp({ content: "❌ Enable SERVER MEMBERS INTENT for giveall.", ephemeral: true });

        let count = 0;
        members.forEach((m) => {
          if (m.user.bot) return;
          getTok(m.id).tokens += amt;
          count++;
        });
        saveTokens();

        return interaction.followUp({ content: `✅ Done. **${count}** members got **${amt}** tokens.`, ephemeral: true });
      }
    }

    if (interaction.commandName === "raceadmin") {
      const sub = interaction.options.getSubcommand();
      const isAdmin = interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);
      if (!isAdmin) return interaction.reply({ content: "❌ Admin only.", ephemeral: true });

      if (sub === "freeze-races-on") {
        settings.freezeRaces = true;
        saveSettings();
        return interaction.reply({ content: "🛠️ Maintenance mode enabled.", ephemeral: true });
      }
      if (sub === "freeze-races-off") {
        settings.freezeRaces = false;
        saveSettings();
        return interaction.reply({ content: "✅ Maintenance mode disabled.", ephemeral: true });
      }
      if (sub === "freeze-payouts-on") {
        settings.freezePayouts = true;
        saveSettings();
        return interaction.reply({ content: "⛔ Payouts frozen.", ephemeral: true });
      }
      if (sub === "freeze-payouts-off") {
        settings.freezePayouts = false;
        saveSettings();
        return interaction.reply({ content: "✅ Payouts unfrozen.", ephemeral: true });
      }

      if (sub === "season-reset") {
        statsDB.users = {};
        statsDB.meta = { seasonStart: Date.now(), seasonNumber: (statsDB.meta?.seasonNumber || 1) + 1 };
        saveStats();
        return interaction.reply({ content: `🧼 Season reset. New season #${statsDB.meta.seasonNumber}`, ephemeral: true });
      }

      if (sub === "season-info") {
        const start = statsDB.meta?.seasonStart || Date.now();
        const days = settings.seasonLengthDays || 14;
        const end = start + days * 24 * 60 * 60 * 1000;
        return interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setColor(COLOR_NEUTRAL)
              .setTitle(`🗓️ Season Info • #${statsDB.meta.seasonNumber}`)
              .setDescription(
                `Start: <t:${Math.floor(start / 1000)}:F>\n` +
                  `Resets: <t:${Math.floor(end / 1000)}:R>\n\n` +
                  `Maintenance Mode: **${settings.freezeRaces ? "ON" : "OFF"}**\n` +
                  `Freeze Payouts: **${settings.freezePayouts ? "ON" : "OFF"}**`
              )
              .setFooter({ text: FOOTER }),
          ],
          ephemeral: true,
        });
      }
    }
  } catch (e) {
    console.log("Interaction error:", e?.message || e);
    if (!interaction.replied) {
      try {
        await interaction.reply({ content: "❌ Something went wrong (check terminal).", ephemeral: true });
      } catch {}
    }
  }
});

// ================== GRACEFUL SHUTDOWN ==================
function gracefulExit(code = 0) {
  try {
    saveSettings();
    saveTokens();
    saveStats();
  } catch {}
  process.exit(code);
}
process.on("SIGINT", () => gracefulExit(0));
process.on("SIGTERM", () => gracefulExit(0));

// ================== START ==================
(async () => {
  if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
    console.error("❌ Missing .env: DISCORD_TOKEN, CLIENT_ID, GUILD_ID");
    process.exit(1);
  }

  ensureDataFiles();

  if (DEPLOY_COMMANDS) {
    await deployCommandsServerOnly();
  } else {
    console.log("ℹ️ DEPLOY_COMMANDS=false (skipping slash command deploy)");
  }

  await client.login(DISCORD_TOKEN);
})();
