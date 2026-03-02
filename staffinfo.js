"use strict";

const { EmbedBuilder } = require("discord.js");

const LABEL_STAFF_PANEL = "Staff Focus";

const STAFF_ROLES = [
  {
    id: "1464790601282093211",
    label: "Owner",
    duties: "Server direction, final decisions, and escalation handling.",
  },
  {
    id: "1464791375831892146",
    label: "Admin",
    duties: "Operations oversight, staffing coverage, and policy enforcement.",
  },
  {
    id: "1464791509294514207",
    label: "Mod",
    duties: "Live moderation, report response, and keeping chats/gameplay clean.",
  },
  {
    id: "1464792499062177904",
    label: "Helper / Trial",
    duties: "Frontline support, onboarding help, and relaying edge cases upward.",
  },
];

function createStaffPanelEmbed({ brand, color, footer, roles = STAFF_ROLES } = {}) {
  const roleLines = roles
    .map((role, idx) => `${idx + 1}. <@&${role.id}> **(${role.label})**\n↳ ${role.duties}`)
    .join("\n\n");

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(`${brand} — STAFF INFO PANEL`)
    .setDescription("Who handles what around the Spiral, and where escalations should route.")
    .addFields({ name: LABEL_STAFF_PANEL, value: roleLines, inline: false })
    .setFooter({ text: footer });
}

module.exports = {
  createStaffPanelEmbed,
  STAFF_ROLES,
};
