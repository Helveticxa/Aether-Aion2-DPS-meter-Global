import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import en from "./locales/en.json";
import ko from "./locales/ko.json";

import enAion2Stats from "./locales/aion2stats/en.json";
import koAion2Stats from "./locales/aion2stats/ko.json";

import enSkills from "./locales/aion2skills/en.json";
import koSkills from "./locales/aion2skills/ko.json";

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { ui: en, aion2skills: enSkills, aion2stats: enAion2Stats },
      ko: { ui: ko, aion2skills: koSkills, aion2stats: koAion2Stats },
    },
    defaultNS: "ui",
    ns: ["ui", "aion2skills", "aion2stats"],
    fallbackLng: "en",
    // Chinese was dropped: this build targets the global service, and every
    // remaining string is authored in English.
    supportedLngs: ["en", "ko"],
    interpolation: {
      escapeValue: false,
    },
    detection: {
      order: ["localStorage", "navigator"],
      caches: ["localStorage"],
      lookupLocalStorage: "i18nextLng",
    },
  });

export default i18n;
