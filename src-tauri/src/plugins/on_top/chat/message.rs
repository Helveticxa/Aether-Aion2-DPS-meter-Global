//! One chat message, the same shape whichever platform it came from, so the
//! overlay can draw YouTube and Twitch side by side in one list.

use serde::Serialize;
use tauri::Url;

use super::source::Platform;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Owner,
    Moderator,
    Vip,
    Member,
    Viewer,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Part {
    Text { text: String },
    Emote { url: String, alt: String },
}

/// A Super Chat, a new member, a resubscription: shown as a band above the
/// message.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Highlight {
    pub label: String,
    /// `#rrggbb`, when the platform gives one.
    pub color: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    /// Unique within its source.
    pub id: String,
    /// The source key (`yt:...`, `tw:...`).
    pub source: String,
    pub platform: Platform,
    pub author: String,
    /// `#rrggbb`: Twitch's chosen name colour.
    pub author_color: Option<String>,
    pub avatar: Option<String>,
    pub role: Role,
    /// Membership or loyalty badge images, when the platform sends them.
    pub badges: Vec<String>,
    pub parts: Vec<Part>,
    pub highlight: Option<Highlight>,
    /// Unix milliseconds.
    pub at: u64,
}

/// What a connector reports.
#[derive(Debug, Clone, PartialEq)]
pub enum ChatEvent {
    Message(ChatMessage),
    /// A moderator deleted it.
    Remove(String),
}

/// Image hosts the platforms serve avatars, emoji, and emotes from. Anything
/// else is dropped: the overlay never loads an address a chat message chose.
const IMAGE_HOSTS: &[&str] = &[
    "ggpht.com",
    "googleusercontent.com",
    "ytimg.com",
    "youtube.com",
    "gstatic.com",
    "static-cdn.jtvnw.net",
];

pub fn safe_image(url: &str) -> Option<String> {
    let url = if let Some(rest) = url.strip_prefix("//") {
        format!("https://{rest}")
    } else {
        url.to_string()
    };
    let parsed = Url::parse(&url).ok()?;
    if parsed.scheme() != "https" {
        return None;
    }
    let host = parsed.host_str()?.to_ascii_lowercase();
    IMAGE_HOSTS
        .iter()
        .any(|allowed| host == *allowed || host.ends_with(&format!(".{allowed}")))
        .then_some(url)
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

/// Joins neighbouring text parts and drops empty ones.
pub fn tidy(parts: Vec<Part>) -> Vec<Part> {
    let mut out: Vec<Part> = Vec::with_capacity(parts.len());
    for part in parts {
        match (out.last_mut(), part) {
            (_, Part::Text { text }) if text.is_empty() => {}
            (Some(Part::Text { text: last }), Part::Text { text }) => last.push_str(&text),
            (_, part) => out.push(part),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_platform_images_only() {
        assert_eq!(
            safe_image("//yt3.ggpht.com/abc=s64"),
            Some("https://yt3.ggpht.com/abc=s64".into())
        );
        assert!(
            safe_image("https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0").is_some()
        );
        assert!(safe_image("https://evil.example/a.png").is_none());
        assert!(safe_image("http://yt3.ggpht.com/abc").is_none());
        assert!(safe_image("https://ggpht.com.evil.example/a.png").is_none());
        assert!(safe_image("javascript:alert(1)").is_none());
    }

    #[test]
    fn tidies_parts() {
        let parts = tidy(vec![
            Part::Text { text: "a".into() },
            Part::Text {
                text: String::new(),
            },
            Part::Text { text: "b".into() },
            Part::Emote {
                url: "u".into(),
                alt: "x".into(),
            },
        ]);
        assert_eq!(
            parts,
            vec![
                Part::Text { text: "ab".into() },
                Part::Emote {
                    url: "u".into(),
                    alt: "x".into()
                }
            ]
        );
    }
}
