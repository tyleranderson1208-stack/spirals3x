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
- `/giveaway-start` (custom prize, visuals, role requirements, account/server age gates)
- `/giveaway-end`, `/giveaway-reroll`, `/giveaway-status`

### Optional environment variables

```env
# Existing global footer is reused in giveaway embeds
UI_FOOTER=🌀 SPIRALS 3X • Premium Systems
```

> Giveaway channels/roles are configured in Discord with `/giveaway-setup`.
