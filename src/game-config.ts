import { Home, Map, type LucideIcon } from "lucide-react";

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
    { label: "Map", path: "/aion2/map", icon: Map },
  ],

  bgVideo: "/aion2/bg.mp4",
  bgImage: "/aion2/background.webp",
};

export const ALL_GAMES: GameConfig[] = [AION2_GAME];

export function getGameByPath(pathname: string): GameConfig | undefined {
  return ALL_GAMES.find((g) => pathname.startsWith(g.rootPath)) ?? ALL_GAMES[0];
}
