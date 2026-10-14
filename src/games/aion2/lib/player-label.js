// What to call a player the game has not named to us yet.
//
// Names come from player-info packets, sent when someone comes into view or a
// zone loads. A meter started in the middle of a zone missed them for everyone
// already there, and used to show those rows as bare ids. Your own row is
// "You" -- the meter knows which id is yours within seconds -- and anyone else
// is their class and number, which still tells a party apart.

const CLASS_LABELS = {
  ASSASSIN: "Assassin",
  CHANTER: "Chanter",
  CLERIC: "Cleric",
  ELEMENTALIST: "Elementalist",
  FIGHTER: "Fighter",
  GLADIATOR: "Gladiator",
  RANGER: "Ranger",
  SORCERER: "Sorcerer",
  TEMPLAR: "Templar",
};

export function playerLabel(actorId, actorName, actorClass, mainActorId) {
  if (actorName) return actorName;
  if (mainActorId != null && Number(actorId) === Number(mainActorId)) return "You";
  const cls = CLASS_LABELS[String(actorClass || "").toUpperCase()] || "Player";
  return `${cls} ${actorId}`;
}

// The same, for a row of an overview list and the snapshot or record it came from.
export function rowLabel(row, source) {
  return playerLabel(row?.actorId, row?.actorName, row?.actorClass, source?.combatInfos?.mainActorId);
}
