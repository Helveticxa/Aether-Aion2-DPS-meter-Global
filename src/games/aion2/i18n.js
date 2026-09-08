import en from "@/i18n/locales/aion2overlay/en.json";
import ko from "@/i18n/locales/aion2overlay/ko.json";

const LOCALES = { en, ko };
let lang = "en";

export function t(key, params) {
  let val = key.split(".").reduce((o, k) => o?.[k], LOCALES[lang]) ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      val = val.replaceAll(`{{${k}}}`, String(v));
    }
  }
  return val;
}

export function setLanguage(l) {
  lang = Object.hasOwn(LOCALES, l) ? l : "en";
}

export function getLanguage() {
  return lang;
}
