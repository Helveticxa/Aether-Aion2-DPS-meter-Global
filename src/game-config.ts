import { Home, LineChart, ShieldCheck, type LucideIcon } from "lucide-react";

import { isCloudEnabled } from "@/lib/supabase";

export type NavItem = {
  label: string;
  path: string;
  icon: LucideIcon;
  activePaths?: string[];
};

export type GameConfig = {
  id: string;
  name: string;
  rootPath: string;
  navItems: NavItem[];
  bgVideo?: string;
  bgImage?: string;
};

export const AION2_GAME: GameConfig = {
  id: "aion2",
  name: "AION2",
  rootPath: "/aion2",
  navItems: [
    { label: "Home", path: "/aion2", icon: Home },
    // Character search and the damage leaderboard both need a community
    // backend: the first a Taiwan-only character API, the second the Supabase
    // project behind the leaderboard. Neither can answer in this build, so they
    // are hidden rather than left to fail in the UI.
    ...(isCloudEnabled
      ? [
          {
            label: "Character",
            path: "/aion2/character/search",
            icon: ShieldCheck,
            activePaths: ["/aion2/character/search", "/aion2/character/view"],
          },
          { label: "Damage Ranking", path: "/aion2/dps-rank", icon: LineChart },
        ]
      : []),
  ],

  bgVideo: "/aion2/bg.mp4",
  bgImage: "/aion2/background.webp",
};

export const POE2_GAME: GameConfig = {
  id: "poe2",
  name: "Path of Exile 2",
  rootPath: "/poe2",
  navItems: [
    { label: "Home", path: "/poe2", icon: Home },
    // { label: "Items", path: "/poe2/items", icon: ShieldCheck },
    // { label: "Passive Tree", path: "/poe2/tree", icon: LineChart },
    // { label: "Market", path: "/poe2/market", icon: BarChart3 },
  ],
  bgVideo: "/poe2/bg.mp4",
  bgImage: "/poe2/wraeclast.webp",
};

export const ALL_GAMES: GameConfig[] = [AION2_GAME];

export function getGameByPath(pathname: string): GameConfig | undefined {
  return ALL_GAMES.find((g) => pathname.startsWith(g.rootPath)) ?? ALL_GAMES[0];
}
