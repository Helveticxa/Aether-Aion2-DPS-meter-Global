import { Link } from "react-router-dom";

const ACTOR_CLASS_NAME_MAP: Record<string, string> = {
  ALL: "All",
  GLADIATOR: "Gladiator",
  TEMPLAR: "Templar",
  ASSASSIN: "Assassin",
  RANGER: "Ranger",
  SORCERER: "Sorcerer",
  ELEMENTALIST: "Elementalist",
  CLERIC: "Cleric",
  CHANTER: "Chanter",
};

export function getActorClassName(actorClass: string | null | undefined) {
  if (!actorClass) {
    return "-";
  }
  return ACTOR_CLASS_NAME_MAP[actorClass] ?? actorClass;
}

function ActorClassIcon({ actorClass }: { actorClass: string | null | undefined }) {
  if (!actorClass || actorClass === "-") {
    return null;
  }

  return (
    <img
      src={`/aion2/class/${actorClass.toLowerCase()}.webp`}
      alt={actorClass}
      className="size-6 shrink-0 rounded-sm"
      loading="lazy"
    />
  );
}

export function ActorNameCell({
  actorName,
  actorClass,
  serverLabel,
  to,
}: {
  actorName: string;
  actorClass: string | null | undefined;
  serverLabel?: string;
  to?: string;
}) {
  const content = (
    <span className="inline-flex min-w-0 items-center gap-2">
      <ActorClassIcon actorClass={actorClass} />
      <span className="truncate">{actorName}</span>
      {serverLabel ? <span className="shrink-0 text-white/50">[{serverLabel}]</span> : null}
    </span>
  );

  if (!to) {
    return <span className="font-semibold text-white">{content}</span>;
  }

  return (
    <Link
      to={to}
      className="font-semibold text-white/90 transition hover:text-white hover:underline"
    >
      {content}
    </Link>
  );
}
