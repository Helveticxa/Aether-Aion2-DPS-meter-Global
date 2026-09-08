import serversData from "@/games/aion2/data/servers.json";

interface Server {
  raceId: number;
  serverId: number;
  serverName: string;
  serverShortName: string;
}

const servers: Server[] = serversData;

// Indexed once; lookups happen per rendered row.
const serverMap = new Map<number, Server>();
servers.forEach((server) => {
  serverMap.set(server.serverId, server);
});

const serversByRace = servers.reduce<Record<number, Server[]>>((acc, server) => {
  if (!acc[server.raceId]) {
    acc[server.raceId] = [];
  }
  acc[server.raceId].push(server);
  return acc;
}, {});

/**
 * Display name for a server id.
 *
 * Only Taiwan's catalogue is bundled. On any other service every id would
 * otherwise render as "unknown", so fall back to the id itself -- it still
 * distinguishes players, and it is language neutral.
 */
export const getServerName = (serverId: number): string => {
  const server = serverMap.get(serverId);
  return server?.serverName || `Server ${serverId}`;
};

/** Short display name, with the same fallback as {@link getServerName}. */
export const getServerShortName = (serverId: number): string => {
  const server = serverMap.get(serverId);
  return server?.serverShortName || `#${serverId}`;
};

export const getServerIdByShortName = (serverShortName: string): number | null => {
  const lowerShortName = serverShortName.toLowerCase();
  for (const [id, server] of serverMap.entries()) {
    if (server.serverShortName.toLowerCase() === lowerShortName) {
      return id;
    }
  }
  return null;
};

export const getAllServers = (): Server[] => {
  return servers;
};

/** Servers for one race (1 = Elyos, 2 = Asmodian). */
export const getRaceServers = (raceId: number): Server[] => {
  return serversByRace[raceId] || [];
};

export const getServerById = (serverId: number): Server | undefined => {
  return serverMap.get(serverId);
};

export const getRaceIds = (): number[] => {
  return Object.keys(serversByRace).map(Number).sort();
};

export const getServerCount = (): number => {
  return servers.length;
};

export const getRaceServerCount = (raceId: number): number => {
  return serversByRace[raceId]?.length || 0;
};

export const hasServer = (serverId: number): boolean => {
  return serverMap.has(serverId);
};

/** Substring match on either the full or the short name. */
export const searchServersByName = (keyword: string): Server[] => {
  if (!keyword) return [];
  const lowerKeyword = keyword.toLowerCase();
  return servers.filter(
    (server) =>
      server.serverName.toLowerCase().includes(lowerKeyword) ||
      server.serverShortName.toLowerCase().includes(lowerKeyword)
  );
};

export const getServerNames = (serverIds: number[]): string[] => {
  return serverIds.map((id) => getServerName(id));
};

/** Options for a select control, optionally narrowed to one race. */
export const getServerOptions = (
  raceId?: number
): Array<{ value: number; label: string; shortName: string }> => {
  const targetServers = raceId ? getRaceServers(raceId) : servers;
  return targetServers.map((server) => ({
    value: server.serverId,
    label: server.serverName,
    shortName: server.serverShortName,
  }));
};

export const RACE_NAMES: Record<number, string> = {
  1: "Elyos",
  2: "Asmodian",
};

export const getRaceName = (raceId: number): string => {
  return RACE_NAMES[raceId] || "Unknown race";
};
