"use strict";

const { ChannelType, PermissionsBitField } = require("discord.js");

const DEFAULT_STATS_CATEGORY_ID = "1464867864782569626";
const AUTO_WIPE_INTERVAL_DAYS = 14;
const AUTO_WIPE_TARGET_WEEKDAY = 5; // Friday (UTC)
const AUTO_WIPE_TARGET_HOUR = 18;
const AUTO_WIPE_TARGET_MINUTE = 0;

function nextUtcWeekdayTimeUnix(fromUnix, weekday, hour, minute) {
  const from = new Date(fromUnix * 1000);
  const day = from.getUTCDay();
  const daysAhead = (weekday - day + 7) % 7;

  const target = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + daysAhead, hour, minute, 0)
  );

  if (Math.floor(target.getTime() / 1000) <= fromUnix) {
    target.setUTCDate(target.getUTCDate() + 7);
  }

  return Math.floor(target.getTime() / 1000);
}

function compactDurationFromNow(targetUnix, nowUnix) {
  if (!targetUnix) return "Not set";
  const diff = targetUnix - nowUnix;
  if (diff <= 0) return "Now";

  const days = Math.floor(diff / 86400);
  const hours = Math.floor((diff % 86400) / 3600);
  const mins = Math.floor((diff % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${Math.max(1, mins)}m`;
}

function createWipeStatsTools({ client, data, saveData, nowUnix }) {
  function resetReminderState(nextUnix) {
    data.reminders.nextWipeKey = String(nextUnix);
    data.reminders.sent = { h24: false, h1: false, m10: false, wipe: false };
  }

  function ensureAutoWipeInitialized() {
    if (data.wipe.nextWipeUnix) return false;

    const nextUnix = nextUtcWeekdayTimeUnix(nowUnix(), AUTO_WIPE_TARGET_WEEKDAY, AUTO_WIPE_TARGET_HOUR, AUTO_WIPE_TARGET_MINUTE);
    data.wipe.lastWipeUnix = nextUnix - AUTO_WIPE_INTERVAL_DAYS * 24 * 3600;
    data.wipe.nextWipeUnix = nextUnix;
    resetReminderState(nextUnix);
    saveData();
    return true;
  }

  function rollAutoWipeScheduleIfDue() {
    if (!data.wipe.nextWipeUnix) return false;

    const intervalSec = AUTO_WIPE_INTERVAL_DAYS * 24 * 3600;
    let changed = false;
    while (nowUnix() >= data.wipe.nextWipeUnix) {
      data.wipe.lastWipeUnix = data.wipe.nextWipeUnix;
      data.wipe.nextWipeUnix += intervalSec;
      resetReminderState(data.wipe.nextWipeUnix);
      changed = true;
    }

    if (changed) saveData();
    return changed;
  }

  async function resolveGuildContext() {
    const channelIds = [
      data.config.panelChannelId,
      data.config.staffPanelChannelId,
      data.config.voteChannelId,
      data.config.resultsChannelId,
    ].filter(Boolean);

    for (const channelId of channelIds) {
      const ch = await client.channels.fetch(channelId).catch(() => null);
      if (ch?.guild) return ch.guild;
    }

    return null;
  }

  async function ensureStatVoiceChannel(guild, key, name) {
    const existingId = data.config[key];
    let channel = existingId ? await client.channels.fetch(existingId).catch(() => null) : null;

    if (!channel || channel.type !== ChannelType.GuildVoice) {
      channel = await guild.channels
        .create({
          name,
          type: ChannelType.GuildVoice,
          parent: data.config.statsCategoryId || null,
        })
        .catch(() => null);

      if (!channel) return null;
      data.config[key] = channel.id;
    }

    const overwrite = {
      id: guild.roles.everyone.id,
      allow: [PermissionsBitField.Flags.ViewChannel],
      deny: data.config.statsLocked ? [PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak] : [],
    };

    const patch = {};
    if (channel.name !== name) patch.name = name;
    if (data.config.statsCategoryId && channel.parentId !== data.config.statsCategoryId) patch.parent = data.config.statsCategoryId;

    if (Object.keys(patch).length) {
      await channel.edit(patch).catch(() => {});
    }

    await channel.permissionOverwrites.edit(overwrite.id, overwrite).catch(() => {});
    return channel;
  }

  async function refreshStatsChannels() {
    const guild = await resolveGuildContext();
    if (!guild) return;

    const memberName = `👥 Members: ${guild.memberCount}`;
    const wipeName = `⏱️ Next Wipe: ${compactDurationFromNow(data.wipe.nextWipeUnix, nowUnix())}`;

    const memberCh = await ensureStatVoiceChannel(guild, "memberStatsChannelId", memberName);
    const wipeCh = await ensureStatVoiceChannel(guild, "nextWipeStatsChannelId", wipeName);

    if (memberCh || wipeCh) saveData();
  }

  return {
    resetReminderState,
    ensureAutoWipeInitialized,
    rollAutoWipeScheduleIfDue,
    refreshStatsChannels,
  };
}

module.exports = {
  DEFAULT_STATS_CATEGORY_ID,
  createWipeStatsTools,
};
