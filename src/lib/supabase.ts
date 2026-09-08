import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

/**
 * Cloud features (account, leaderboard upload, avatar storage) are optional.
 *
 * Upstream NOIA2 ships without credentials -- `.env` is gitignored -- so in this
 * fork `createClient()` would throw "supabaseUrl is required." at module load and
 * take the whole app down with it. Everything cloud-related is therefore gated
 * behind this flag, and the meter itself runs fully offline without it.
 *
 * To enable, create a `.env` with VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.
 */
export const isCloudEnabled = Boolean(supabaseUrl && supabaseAnonKey);

export const supabase: SupabaseClient | null = isCloudEnabled
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: true,
        storage: localStorage,
      },
    })
  : null;

/** Use inside handlers that already catch and surface errors to the user. */
export function requireSupabase(): SupabaseClient {
  if (!supabase) {
    throw new Error(
      "Cloud features are disabled in this build. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to enable them.",
    );
  }
  return supabase;
}
