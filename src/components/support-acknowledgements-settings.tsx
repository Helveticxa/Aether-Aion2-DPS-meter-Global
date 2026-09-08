import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SettingsGroup, SettingsSectionHeader } from "@/components/settings-layout";

type CreditItem = {
  name: string;
  description: string;
  href: string;
  avatarSrc?: string;
  avatarFallback: string;
  badge: string;
};

/**
 * Aether is a fork, and this page says so plainly.
 *
 * Upstream's own page collected donations and community group numbers; those
 * belong to that project and its author, not to this fork, so they are not
 * reproduced here. The credit itself is.
 */
const UPSTREAM: CreditItem = {
  name: "ZDYoung0519/NOIA2",
  description:
    "Aether is a fork of NOIA2 by zdyoung: the capture pipeline, the packet parsers, the overlay, and the game-data catalogues all come from that project.",
  href: "https://github.com/ZDYoung0519/NOIA2",
  avatarSrc: "https://avatars.githubusercontent.com/u/60741049?s=80&v=4",
  avatarFallback: "NO",
  badge: "Upstream",
};

const TECHNICAL_CREDITS: CreditItem[] = [
  {
    name: "TK-open-public/Aion2-Dps-Meter",
    description: "Reference for AION2 packet parsing, and the source of the Korean server block.",
    href: "https://github.com/TK-open-public/Aion2-Dps-Meter",
    avatarSrc: "https://avatars.githubusercontent.com/u/253818446?s=80&v=4",
    avatarFallback: "TK",
    badge: "Reference",
  },
  {
    name: "taengu/Aion2-Dps-Meter",
    description: "Another open implementation of an AION2 DPS meter.",
    href: "https://github.com/taengu/Aion2-Dps-Meter",
    avatarSrc: "https://avatars.githubusercontent.com/u/7606218?s=80&v=4",
    avatarFallback: "TG",
    badge: "Reference",
  },
  {
    name: "p62003/aletheia_AION2_DPS_Meter",
    description: "Reference for combat-data presentation and analysis.",
    href: "https://github.com/p62003/aletheia_AION2_DPS_Meter",
    avatarSrc: "https://avatars.githubusercontent.com/u/125135560?s=80&v=4",
    avatarFallback: "P6",
    badge: "Reference",
  },
];

function openExternalLink(href: string) {
  void openUrl(href);
}

function CreditRow({ item }: { item: CreditItem }) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-4">
      <div className="flex min-w-0 items-center gap-3">
        <Avatar size="lg">
          {item.avatarSrc ? <AvatarImage src={item.avatarSrc} alt={item.name} /> : null}
          <AvatarFallback>{item.avatarFallback}</AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium">{item.name}</span>
            <Badge variant="secondary">{item.badge}</Badge>
          </div>
          <p className="text-muted-foreground text-xs leading-5">{item.description}</p>
        </div>
      </div>
      <Button variant="outline" size="sm" onClick={() => openExternalLink(item.href)}>
        <ExternalLink data-icon="inline-start" />
        Open
      </Button>
    </div>
  );
}

export function SupportAcknowledgementsSettings() {
  return (
    <div className="flex flex-col gap-8">
      <SettingsSectionHeader
        title="Credits"
        description="Aether stands on other people's work. This page records whose."
      />

      <SettingsGroup title="Built on">
        <CreditRow item={UPSTREAM} />
        <div className="text-muted-foreground px-5 pb-5 text-xs leading-5">
          Both projects are licensed GPL-3.0-only. If Aether is useful to you, consider supporting
          upstream directly through the links on the NOIA2 repository.
        </div>
      </SettingsGroup>

      <SettingsGroup title="References">
        {TECHNICAL_CREDITS.map((item) => (
          <CreditRow key={item.href} item={item} />
        ))}
      </SettingsGroup>
    </div>
  );
}
