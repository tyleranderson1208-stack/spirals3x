RUSTYREDS 3X • RHIB Race Bot

A Discord bot for the RUSTYREDS 3X RHIB racing game with tiers, achievements, party lobbies, Kaos payouts, and seasonal stats.

## Setup

1. Install dependencies:
   ```bash
   npm install

## Giveaway System (new)

The bot now includes a fully customizable giveaway module with:
- `/giveaway-setup` (channel/log/ping/reminders)
- `/giveaway-panel` (staff control panel)
- `/giveaway-start` (custom prize, visuals, required/bonus role rules, optional winner role reward)
- `/giveaway-schedule`, `/giveaway-end`, `/giveaway-reroll`, `/giveaway-status`

### Optional environment variables

```env
# Existing global footer is reused in giveaway embeds
UI_FOOTER=🌀 SPIRALS 3X • Premium Systems
```

> Giveaway channels/roles are configured in Discord with `/giveaway-setup`.

## Signal Roles Panel (new)

Adds `/signals-panel` to post a themed role-toggle panel for:
- Giveaways
- Polls
- Suggestions
- Events
- Raid Alerts
- Nuke Alerts

Users click buttons to toggle alert roles on/off.

Optional env overrides:
```env
SIGNAL_ROLES_CHANNEL_ID=1465517573108928628
SIGNAL_ROLE_GIVEAWAYS=1477073449259106528
SIGNAL_ROLE_POLLS=1477073705606840451
SIGNAL_ROLE_SUGGESTIONS=1477073787240583289
SIGNAL_ROLE_EVENTS=1477073813739933847
SIGNAL_ROLE_RAID=1477073911572070583
SIGNAL_ROLE_NUKE=1477073963694686281
```
