// Skill names for the overlays, loaded on first use.
//
// The catalogues are ~220 KB each, and the meter only needs them for a fight
// summary, so they are split out of the overlay bundle and fetched when the
// first summary is drawn rather than on every start.

const tables = new Map();

export async function loadSkillNames(language) {
  const lang = language === "ko" ? "ko" : "en";
  if (!tables.has(lang)) {
    const module =
      lang === "ko"
        ? await import("@/i18n/locales/aion2skills/ko.json")
        : await import("@/i18n/locales/aion2skills/en.json");
    tables.set(lang, module.default);
  }
  return tables.get(lang);
}

// The same lookup the detail window uses: an exact id first, then the forms
// the backend normalises skill ids to.
function candidates(id) {
  const raw = String(id);
  const list = [raw, raw.slice(0, 8)];
  if (raw.length > 8) list.push(raw.slice(0, 8).replace(/\d$/, "0"));
  if (raw.length > 6) list.push(raw.slice(0, 6).padEnd(8, "0"));
  return [...new Set(list)];
}

export function skillName(table, id) {
  if (table) {
    for (const candidate of candidates(id)) {
      if (table[candidate]) return table[candidate];
    }
  }
  return `Skill ${id}`;
}
