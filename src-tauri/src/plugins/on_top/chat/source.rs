//! What someone pasted, and which chat it names.

use serde::{Deserialize, Serialize};
use tauri::Url;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Youtube,
    Twitch,
}

/// A chat Aether can read: a YouTube live video or a Twitch channel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSpec {
    pub platform: Platform,
    /// YouTube video id, or Twitch channel login (lowercase).
    pub id: String,
    /// What to call it on screen.
    pub name: String,
    /// YouTube only: its filtered "Top chat" instead of every message.
    #[serde(default)]
    pub top_chat: bool,
}

impl SourceSpec {
    /// One connector per key, however many pop-ups show it.
    pub fn key(&self) -> String {
        match self.platform {
            Platform::Youtube if self.top_chat => format!("yt:{}:top", self.id),
            Platform::Youtube => format!("yt:{}", self.id),
            Platform::Twitch => format!("tw:{}", self.id),
        }
    }

    /// Checked again whenever a spec arrives from the page, which stores it.
    pub fn is_valid(&self) -> bool {
        match self.platform {
            Platform::Youtube => is_video_id(&self.id),
            Platform::Twitch => is_twitch_login(&self.id),
        }
    }
}

/// What the text turned out to be.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Parsed {
    YoutubeVideo(String),
    /// A channel path such as `@handle` or `channel/UC...`, whose current
    /// stream is looked up.
    YoutubeChannel(String),
    Twitch(String),
    /// Recognised, and refused for a reason worth telling the person.
    TikTok,
}

pub fn is_video_id(text: &str) -> bool {
    text.len() == 11
        && text
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Twitch logins: 3 to 25 of letters, digits and underscores.
pub fn is_twitch_login(text: &str) -> bool {
    (3..=25).contains(&text.len()) && text.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn is_channel_segment(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 100
        && text
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.' | '@'))
}

/// Twitch paths that are pages, not channels.
const TWITCH_RESERVED: &[&str] = &[
    "directory",
    "videos",
    "settings",
    "subscriptions",
    "inventory",
    "wallet",
    "search",
    "downloads",
    "jobs",
    "p",
    "prime",
    "turbo",
    "friends",
    "messages",
    "drops",
];

pub fn parse(input: &str) -> Result<Parsed, String> {
    let text = input.trim();
    if text.is_empty() {
        return Err("Paste a YouTube or Twitch live link.".into());
    }
    if is_video_id(text) {
        return Ok(Parsed::YoutubeVideo(text.to_string()));
    }
    if let Some(handle) = text.strip_prefix('@') {
        return if is_channel_segment(handle) {
            Ok(Parsed::YoutubeChannel(format!("@{handle}")))
        } else {
            Err("That handle has characters YouTube does not use.".into())
        };
    }

    let with_scheme = if text.contains("://") {
        text.to_string()
    } else {
        format!("https://{text}")
    };
    let url = Url::parse(&with_scheme)
        .map_err(|_| "That is not a YouTube or Twitch link.".to_string())?;
    let host = url
        .host_str()
        .unwrap_or_default()
        .to_ascii_lowercase()
        .trim_start_matches("www.")
        .trim_start_matches("m.")
        .to_string();
    let segments: Vec<&str> = url
        .path_segments()
        .map(|parts| parts.filter(|s| !s.is_empty()).collect())
        .unwrap_or_default();

    if host == "tiktok.com" || host.ends_with(".tiktok.com") {
        return Ok(Parsed::TikTok);
    }

    if host == "twitch.tv" || host.ends_with(".twitch.tv") {
        // twitch.tv/<channel>, twitch.tv/popout/<channel>/chat,
        // twitch.tv/embed/<channel>/chat
        let channel = match segments.as_slice() {
            ["popout" | "embed", channel, ..] => channel,
            [channel, ..] => channel,
            [] => return Err("That Twitch link has no channel in it.".into()),
        };
        let login = channel.to_ascii_lowercase();
        if TWITCH_RESERVED.contains(&login.as_str()) || !is_twitch_login(&login) {
            return Err("Could not find a Twitch channel in that link.".into());
        }
        return Ok(Parsed::Twitch(login));
    }

    let video = |id: &str| -> Result<Parsed, String> {
        if is_video_id(id) {
            Ok(Parsed::YoutubeVideo(id.to_string()))
        } else {
            Err("That link does not contain a valid video id.".into())
        }
    };

    if host == "youtu.be" {
        return segments.first().map_or_else(
            || Err("That link has no video in it.".into()),
            |id| video(id),
        );
    }
    if host != "youtube.com" && !host.ends_with(".youtube.com") {
        return Err("That is not a YouTube or Twitch link.".into());
    }

    if let Some((_, id)) = url.query_pairs().find(|(key, _)| key == "v") {
        return video(&id);
    }
    match segments.as_slice() {
        ["live" | "shorts" | "embed" | "video", id, ..] => video(id),
        [first, ..] if first.starts_with('@') && is_channel_segment(first) => {
            Ok(Parsed::YoutubeChannel(first.to_string()))
        }
        ["channel" | "c" | "user", name, ..] if is_channel_segment(name) => {
            Ok(Parsed::YoutubeChannel(format!("{}/{}", segments[0], name)))
        }
        _ => Err("Could not find a video or channel in that link.".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_every_kind_of_youtube_link() {
        let id = "wYM_8XBICas";
        for input in [
            id,
            "https://www.youtube.com/watch?v=wYM_8XBICas",
            "youtube.com/watch?v=wYM_8XBICas&t=10",
            "https://youtu.be/wYM_8XBICas",
            "https://www.youtube.com/live/wYM_8XBICas?si=abc",
            "https://studio.youtube.com/video/wYM_8XBICas/livestreaming",
            "https://studio.youtube.com/live_chat?is_popout=1&v=wYM_8XBICas",
            "https://m.youtube.com/watch?v=wYM_8XBICas",
        ] {
            assert_eq!(parse(input), Ok(Parsed::YoutubeVideo(id.into())), "{input}");
        }
    }

    #[test]
    fn reads_youtube_channels() {
        assert_eq!(
            parse("@ForgeLabs_id"),
            Ok(Parsed::YoutubeChannel("@ForgeLabs_id".into()))
        );
        assert_eq!(
            parse("https://www.youtube.com/@ForgeLabs_id/streams"),
            Ok(Parsed::YoutubeChannel("@ForgeLabs_id".into()))
        );
        assert_eq!(
            parse("https://www.youtube.com/channel/UCabcdefghij0123456789ab"),
            Ok(Parsed::YoutubeChannel(
                "channel/UCabcdefghij0123456789ab".into()
            ))
        );
    }

    #[test]
    fn reads_twitch_channels() {
        for input in [
            "https://www.twitch.tv/xQc",
            "twitch.tv/xqc",
            "https://m.twitch.tv/xqc/",
            "https://www.twitch.tv/popout/xqc/chat?popout=",
            "https://www.twitch.tv/embed/xqc/chat?parent=example.com",
        ] {
            assert_eq!(parse(input), Ok(Parsed::Twitch("xqc".into())), "{input}");
        }
        assert!(parse("https://www.twitch.tv/directory").is_err());
        assert!(parse("https://www.twitch.tv/").is_err());
    }

    #[test]
    fn recognises_tiktok_to_explain_it() {
        assert_eq!(
            parse("https://www.tiktok.com/@someone/live"),
            Ok(Parsed::TikTok)
        );
        assert_eq!(parse("tiktok.com/@someone/live"), Ok(Parsed::TikTok));
    }

    #[test]
    fn refuses_other_sites() {
        assert!(parse("").is_err());
        assert!(parse("https://evil.example/watch?v=wYM_8XBICas").is_err());
        assert!(parse("https://www.youtube.com/watch?v=short").is_err());
        assert!(parse("@bad handle").is_err());
    }

    #[test]
    fn keys_separate_filtered_and_full_chats() {
        let spec = |top_chat| SourceSpec {
            platform: Platform::Youtube,
            id: "wYM_8XBICas".into(),
            name: String::new(),
            top_chat,
        };
        assert_eq!(spec(false).key(), "yt:wYM_8XBICas");
        assert_eq!(spec(true).key(), "yt:wYM_8XBICas:top");
        let twitch = SourceSpec {
            platform: Platform::Twitch,
            id: "xqc".into(),
            name: String::new(),
            top_chat: false,
        };
        assert_eq!(twitch.key(), "tw:xqc");
        assert!(twitch.is_valid());
    }
}
