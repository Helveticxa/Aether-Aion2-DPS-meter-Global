//! Twitch chat over its public IRC interface, read-only and anonymous.
//!
//! Twitch lets anyone read a channel's chat as `justinfan<number>` with no
//! account, over TLS on port 6697. Tags carry display names, colours, badges,
//! and emote positions, which is everything the overlay needs.

use std::{
    collections::HashMap,
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};

use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::TcpStream,
    time::timeout,
};
use tokio_rustls::{
    rustls::{pki_types::ServerName, ClientConfig, RootCertStore},
    TlsConnector,
};

use super::message::{now_ms, tidy, ChatEvent, ChatMessage, Highlight, Part, Role};
use super::source::{Platform, SourceSpec};
use super::youtube::backoff;
use super::{deliver, set_state, SourceState};

const HOST: &str = "irc.chat.twitch.tv";

fn tls_config() -> Arc<ClientConfig> {
    static CONFIG: OnceLock<Arc<ClientConfig>> = OnceLock::new();
    CONFIG
        .get_or_init(|| {
            let mut roots = RootCertStore::empty();
            roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
            // The provider is named rather than taken from the process
            // default: more than one crate in the tree links a TLS backend.
            let config = ClientConfig::builder_with_provider(Arc::new(
                tokio_rustls::rustls::crypto::ring::default_provider(),
            ))
            .with_safe_default_protocol_versions()
            .expect("ring supports the default TLS versions")
            .with_root_certificates(roots)
            .with_no_client_auth();
            Arc::new(config)
        })
        .clone()
}

// =============================================================================
// Parsing
// =============================================================================

/// IRCv3 tag values escape `;`, spaces, backslashes and line breaks.
fn unescape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('s') => out.push(' '),
            Some(':') => out.push(';'),
            Some('r') => out.push('\r'),
            Some('n') => out.push('\n'),
            Some(other) => out.push(other),
            None => {}
        }
    }
    out
}

fn parse_tags(raw: &str) -> HashMap<String, String> {
    raw.split(';')
        .filter_map(|pair| {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            Some((key.to_string(), unescape(value)))
        })
        .collect()
}

/// Twitch's own palette for people who never chose a colour, picked by name
/// so the same person keeps the same colour.
const DEFAULT_COLORS: &[&str] = &[
    "#ff4a4a", "#4a7bff", "#28c828", "#b22222", "#ff7f50", "#9acd32", "#ff5a1f", "#2e8b57",
    "#daa520", "#d2691e", "#5f9ea0", "#1e90ff", "#ff69b4", "#8a2be2", "#00ff7f",
];

fn name_color(name: &str, tagged: Option<&String>) -> String {
    if let Some(color) = tagged {
        let valid = color.len() == 7
            && color.starts_with('#')
            && color[1..].chars().all(|c| c.is_ascii_hexdigit());
        if valid {
            return color.to_ascii_lowercase();
        }
    }
    let sum: u32 = name.bytes().map(u32::from).sum();
    DEFAULT_COLORS[(sum as usize) % DEFAULT_COLORS.len()].to_string()
}

fn role_of(badges: Option<&String>) -> Role {
    let mut role = Role::Viewer;
    for badge in badges.map(String::as_str).unwrap_or("").split(',') {
        let name = badge.split('/').next().unwrap_or("");
        let rank = match name {
            "broadcaster" => Role::Owner,
            "moderator" => Role::Moderator,
            "vip" => Role::Vip,
            "subscriber" | "founder" => Role::Member,
            _ => continue,
        };
        let order = |r: Role| match r {
            Role::Owner => 4,
            Role::Moderator => 3,
            Role::Vip => 2,
            Role::Member => 1,
            Role::Viewer => 0,
        };
        if order(rank) > order(role) {
            role = rank;
        }
    }
    role
}

/// Emote ranges index characters, not bytes: `25:0-4,12-16/1902:6-10`.
fn parts_with_emotes(text: &str, emotes: Option<&String>) -> Vec<Part> {
    let mut ranges: Vec<(usize, usize, String)> = emotes
        .map(String::as_str)
        .unwrap_or("")
        .split('/')
        .filter_map(|entry| entry.split_once(':'))
        .flat_map(|(id, spans)| {
            spans.split(',').filter_map(move |span| {
                let (start, end) = span.split_once('-')?;
                Some((start.parse().ok()?, end.parse().ok()?, id.to_string()))
            })
        })
        .collect();
    ranges.sort_by_key(|(start, _, _)| *start);

    let chars: Vec<char> = text.chars().collect();
    let mut parts = Vec::new();
    let mut cursor = 0usize;
    for (start, end, id) in ranges {
        if start < cursor || end >= chars.len() || end < start {
            continue;
        }
        parts.push(Part::Text {
            text: chars[cursor..start].iter().collect(),
        });
        let alt: String = chars[start..=end].iter().collect();
        let id_ok = id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
        if id_ok {
            parts.push(Part::Emote {
                url: format!("https://static-cdn.jtvnw.net/emoticons/v2/{id}/default/dark/1.0"),
                alt,
            });
        } else {
            parts.push(Part::Text { text: alt });
        }
        cursor = end + 1;
    }
    parts.push(Part::Text {
        text: chars[cursor.min(chars.len())..].iter().collect(),
    });
    tidy(parts)
}

fn message(
    tags: &HashMap<String, String>,
    nick: &str,
    text: &str,
    highlight: Option<Highlight>,
    source: &str,
) -> ChatMessage {
    // "/me waves" arrives as \x01ACTION waves\x01.
    let text = text
        .strip_prefix("\u{1}ACTION ")
        .map(|t| t.trim_end_matches('\u{1}'))
        .unwrap_or(text);
    let author = tags
        .get("display-name")
        .filter(|name| !name.is_empty())
        .cloned()
        .unwrap_or_else(|| nick.to_string());
    let at = tags
        .get("tmi-sent-ts")
        .and_then(|ts| ts.parse().ok())
        .unwrap_or_else(now_ms);
    ChatMessage {
        id: tags
            .get("id")
            .cloned()
            .unwrap_or_else(|| format!("{nick}-{at}")),
        source: source.to_string(),
        platform: Platform::Twitch,
        author_color: Some(name_color(&author, tags.get("color"))),
        author,
        author_id: tags.get("user-id").filter(|id| !id.is_empty()).cloned(),
        avatar: None,
        role: role_of(tags.get("badges")),
        badges: Vec::new(),
        parts: parts_with_emotes(text, tags.get("emotes")),
        highlight,
        at,
    }
}

/// One line from the server, if it is something the overlay shows.
pub fn parse_line(line: &str, source: &str) -> Option<ChatEvent> {
    let (tags, rest) = match line.strip_prefix('@') {
        Some(stripped) => {
            let (raw, rest) = stripped.split_once(' ')?;
            (parse_tags(raw), rest)
        }
        None => (HashMap::new(), line),
    };
    let (prefix, rest) = match rest.strip_prefix(':') {
        Some(stripped) => {
            let (prefix, rest) = stripped.split_once(' ')?;
            (prefix, rest)
        }
        None => ("", rest),
    };
    let nick = prefix.split('!').next().unwrap_or("");
    let (command, params) = rest.split_once(' ').unwrap_or((rest, ""));
    let trailing = params.split_once(" :").map(|(_, text)| text);

    match command {
        "PRIVMSG" => Some(ChatEvent::Message(message(
            &tags, nick, trailing?, None, source,
        ))),
        // Subscriptions, raids, gifted subs: a system line, and sometimes the
        // person's own message with it.
        "USERNOTICE" => {
            let system = tags.get("system-msg").cloned().unwrap_or_default();
            if system.is_empty() && trailing.is_none() {
                return None;
            }
            let highlight = Highlight {
                label: system,
                color: Some("#9146ff".into()),
            };
            let login = tags.get("login").cloned().unwrap_or_default();
            Some(ChatEvent::Message(message(
                &tags,
                &login,
                trailing.unwrap_or(""),
                Some(highlight),
                source,
            )))
        }
        "CLEARMSG" => tags
            .get("target-msg-id")
            .map(|id| ChatEvent::Remove(id.clone())),
        // A ban or timeout names its target; without one the whole chat was
        // cleared.
        "CLEARCHAT" => Some(match tags.get("target-user-id") {
            Some(user) if !user.is_empty() => ChatEvent::RemoveAuthor(user.clone()),
            _ => ChatEvent::Clear,
        }),
        _ => None,
    }
}

/// The IRC command of a line, past its tags and prefix.
fn command_of(line: &str) -> &str {
    let mut rest = line;
    if rest.starts_with('@') {
        rest = rest.split_once(' ').map_or("", |(_, r)| r);
    }
    if rest.starts_with(':') {
        rest = rest.split_once(' ').map_or("", |(_, r)| r);
    }
    rest.split(' ').next().unwrap_or("")
}

// =============================================================================
// Connection
// =============================================================================

fn anonymous_nick() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    format!("justinfan{}", 10_000 + nanos % 80_000)
}

enum Ended {
    /// Twitch asked us to reconnect: not a failure.
    Reconnect,
}

/// Busy channels send dozens of lines a second. They are handed on in small
/// batches, so each pop-up redraws a few times a second rather than per line.
const FLUSH_EVERY: Duration = Duration::from_millis(150);
const FLUSH_AT: usize = 50;
/// Joining a channel that does not exist is met with silence, not an error.
const JOIN_WAIT: Duration = Duration::from_secs(15);
/// Twitch pings every five minutes; silence well past that means the
/// connection is gone without having said so.
const SILENCE: Duration = Duration::from_secs(400);

fn flush(key: &str, pending: &mut Vec<ChatEvent>, since: &mut Option<Instant>) {
    *since = None;
    if !pending.is_empty() {
        deliver(key, std::mem::take(pending));
    }
}

/// One connection. `joined` tells the caller whether it got into the channel,
/// which makes a later failure a fresh one rather than another in a row.
async fn session(login: &str, key: &str, joined: &mut bool) -> Result<Ended, String> {
    let tcp = timeout(Duration::from_secs(10), TcpStream::connect((HOST, 6697)))
        .await
        .map_err(|_| "Twitch did not answer.".to_string())?
        .map_err(|e| format!("Could not reach Twitch: {e}"))?;
    let name = ServerName::try_from(HOST).map_err(|e| e.to_string())?;
    let tls = TlsConnector::from(tls_config())
        .connect(name, tcp)
        .await
        .map_err(|e| format!("Could not secure the Twitch connection: {e}"))?;
    let (read, mut write) = tokio::io::split(tls);

    let hello = format!(
        "CAP REQ :twitch.tv/tags twitch.tv/commands\r\nPASS SCHMOOPIIE\r\nNICK {}\r\nJOIN #{login}\r\n",
        anonymous_nick()
    );
    write
        .write_all(hello.as_bytes())
        .await
        .map_err(|e| e.to_string())?;

    let mut lines = BufReader::new(read).lines();
    let started = Instant::now();
    let mut last_line = Instant::now();
    let mut reported_missing = false;
    let mut pending: Vec<ChatEvent> = Vec::new();
    let mut pending_since: Option<Instant> = None;

    loop {
        // Wake for whichever comes first: a line, a batch to hand on, the
        // join deadline, or the silence limit.
        let mut wait = SILENCE.saturating_sub(last_line.elapsed());
        if !*joined && !reported_missing {
            wait = wait.min(JOIN_WAIT.saturating_sub(started.elapsed()));
        }
        if let Some(since) = pending_since {
            wait = wait.min(FLUSH_EVERY.saturating_sub(since.elapsed()));
        }
        let next = timeout(wait, lines.next_line()).await;

        if pending_since.is_some_and(|since| since.elapsed() >= FLUSH_EVERY) {
            flush(key, &mut pending, &mut pending_since);
        }

        let line = match next {
            Ok(Ok(Some(line))) => line,
            Ok(Ok(None)) => {
                flush(key, &mut pending, &mut pending_since);
                return Err("Twitch closed the connection.".into());
            }
            Ok(Err(e)) => {
                flush(key, &mut pending, &mut pending_since);
                return Err(e.to_string());
            }
            Err(_) => {
                if !*joined && !reported_missing && started.elapsed() >= JOIN_WAIT {
                    reported_missing = true;
                    set_state(
                        key,
                        SourceState::Error,
                        Some(format!("Twitch has no channel called {login}.")),
                    );
                }
                if last_line.elapsed() >= SILENCE {
                    return Err("Twitch went quiet. Reconnecting.".into());
                }
                continue;
            }
        };
        last_line = Instant::now();

        // Decided by the command itself: "RECONNECT" typed into chat is a
        // PRIVMSG, and must not drop the connection.
        match command_of(&line) {
            "PING" => {
                let payload = line.strip_prefix("PING").unwrap_or("");
                let _ = write
                    .write_all(format!("PONG{payload}\r\n").as_bytes())
                    .await;
                continue;
            }
            "RECONNECT" => {
                flush(key, &mut pending, &mut pending_since);
                return Ok(Ended::Reconnect);
            }
            "ROOMSTATE" | "366" if !*joined => {
                *joined = true;
                set_state(key, SourceState::Live, None);
            }
            // A suspended or banned channel answers the JOIN with a notice.
            "NOTICE" if !*joined => {
                let text = line.split_once(" :").map(|(_, text)| text.to_string());
                return Err(text.unwrap_or_else(|| format!("Twitch refused #{login}.")));
            }
            _ => {}
        }

        if let Some(event) = parse_line(&line, key) {
            if !*joined {
                *joined = true;
                set_state(key, SourceState::Live, None);
            }
            pending.push(event);
            pending_since.get_or_insert_with(Instant::now);
            if pending.len() >= FLUSH_AT {
                flush(key, &mut pending, &mut pending_since);
            }
        }
    }
}

/// Follows one Twitch channel's chat until the task is aborted.
pub async fn run(spec: SourceSpec) {
    let key = spec.key();
    let mut failures = 0u32;
    loop {
        set_state(&key, SourceState::Connecting, None);
        let mut joined = false;
        let result = session(&spec.id, &key, &mut joined).await;
        // A connection that got in resets the count: hours of chat and one
        // dropped connection should retry in seconds, not minutes.
        if joined {
            failures = 0;
        }
        if let Err(error) = result {
            failures += 1;
            set_state(&key, SourceState::Error, Some(error));
        }
        tokio::time::sleep(if failures == 0 {
            Duration::from_secs(1)
        } else {
            backoff(failures)
        })
        .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_message_with_emotes_badges_and_colour() {
        let line = "@badges=moderator/1,subscriber/12;color=#1E90FF;display-name=Alice\\sB;emotes=25:6-10/1902:12-16;id=abc;tmi-sent-ts=1700000000000 :alice!alice@alice.tmi.twitch.tv PRIVMSG #xqc :hello Kappa Keepo!";
        let Some(ChatEvent::Message(m)) = parse_line(line, "tw:xqc") else {
            panic!()
        };
        assert_eq!(m.author, "Alice B");
        assert_eq!(m.author_color.as_deref(), Some("#1e90ff"));
        assert_eq!(m.role, Role::Moderator);
        assert_eq!(m.id, "abc");
        assert_eq!(m.at, 1_700_000_000_000);
        assert_eq!(
            m.parts,
            vec![
                Part::Text {
                    text: "hello ".into()
                },
                Part::Emote {
                    url: "https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0".into(),
                    alt: "Kappa".into()
                },
                Part::Text { text: " ".into() },
                Part::Emote {
                    url: "https://static-cdn.jtvnw.net/emoticons/v2/1902/default/dark/1.0".into(),
                    alt: "Keepo".into()
                },
                Part::Text { text: "!".into() },
            ]
        );
    }

    #[test]
    fn emote_positions_count_characters_not_bytes() {
        let line = "@emotes=25:2-6;id=x :a!a@a PRIVMSG #c :é Kappa";
        let Some(ChatEvent::Message(m)) = parse_line(line, "tw:c") else {
            panic!()
        };
        assert!(matches!(&m.parts[1], Part::Emote { alt, .. } if alt == "Kappa"));
    }

    #[test]
    fn unnamed_colours_stay_stable_per_person() {
        let line = "@display-name=bob;id=1 :bob!bob@bob PRIVMSG #c :hi";
        let first = parse_line(line, "tw:c");
        let second = parse_line(line, "tw:c");
        let color = |e: Option<ChatEvent>| match e {
            Some(ChatEvent::Message(m)) => m.author_color,
            _ => None,
        };
        assert_eq!(color(first), color(second));
    }

    #[test]
    fn strips_me_actions() {
        let line = "@id=1 :bob!bob@bob PRIVMSG #c :\u{1}ACTION waves\u{1}";
        let Some(ChatEvent::Message(m)) = parse_line(line, "tw:c") else {
            panic!()
        };
        assert_eq!(
            m.parts,
            vec![Part::Text {
                text: "waves".into()
            }]
        );
    }

    #[test]
    fn subscriptions_become_highlights_and_deletions_removals() {
        let sub = "@badges=subscriber/12;display-name=Carol;login=carol;msg-id=resub;system-msg=Carol\\ssubscribed\\sfor\\s12\\smonths!;id=s1 :tmi.twitch.tv USERNOTICE #c :still here";
        let Some(ChatEvent::Message(m)) = parse_line(sub, "tw:c") else {
            panic!()
        };
        assert_eq!(
            m.highlight.unwrap().label,
            "Carol subscribed for 12 months!"
        );
        assert_eq!(m.role, Role::Member);
        assert_eq!(
            m.parts,
            vec![Part::Text {
                text: "still here".into()
            }]
        );

        let clear = "@login=bob;target-msg-id=abc-123 :tmi.twitch.tv CLEARMSG #c :bad words";
        assert_eq!(
            parse_line(clear, "tw:c"),
            Some(ChatEvent::Remove("abc-123".into()))
        );
    }

    #[test]
    fn ignores_everything_else() {
        assert_eq!(
            parse_line(":tmi.twitch.tv 001 justinfan1 :Welcome, GLHF!", "tw:c"),
            None
        );
        assert_eq!(
            parse_line("@room-id=1 :tmi.twitch.tv ROOMSTATE #c", "tw:c"),
            None
        );
        assert_eq!(parse_line("PING :tmi.twitch.tv", "tw:c"), None);
    }

    #[test]
    fn bans_take_the_authors_messages_and_clears_take_everything() {
        let ban = "@ban-duration=600;room-id=1;target-user-id=42;tmi-sent-ts=1 :tmi.twitch.tv CLEARCHAT #c :spammer";
        assert_eq!(
            parse_line(ban, "tw:c"),
            Some(ChatEvent::RemoveAuthor("42".into()))
        );
        let wipe = "@room-id=1;tmi-sent-ts=1 :tmi.twitch.tv CLEARCHAT #c";
        assert_eq!(parse_line(wipe, "tw:c"), Some(ChatEvent::Clear));

        let said = "@user-id=42;display-name=Spammer :spammer!spammer@spammer.tmi.twitch.tv PRIVMSG #c :hi";
        let Some(ChatEvent::Message(m)) = parse_line(said, "tw:c") else {
            panic!()
        };
        assert_eq!(m.author_id.as_deref(), Some("42"));
    }

    /// Chat text that happens to name a command must not act as one.
    #[test]
    fn commands_come_from_the_command_not_the_text() {
        assert_eq!(command_of("PING :tmi.twitch.tv"), "PING");
        assert_eq!(command_of(":tmi.twitch.tv RECONNECT"), "RECONNECT");
        assert_eq!(
            command_of("@id=1 :a!a@a.tmi.twitch.tv PRIVMSG #c :lol RECONNECT 366 ROOMSTATE"),
            "PRIVMSG"
        );
        assert_eq!(
            command_of("@room-id=1 :tmi.twitch.tv ROOMSTATE #c"),
            "ROOMSTATE"
        );
        assert_eq!(
            command_of(":justinfan1.tmi.twitch.tv 366 justinfan1 #c :End of /NAMES list"),
            "366"
        );
    }

    #[test]
    fn broadcaster_outranks_everything() {
        assert_eq!(
            role_of(Some(&"subscriber/1,broadcaster/1".to_string())),
            Role::Owner
        );
        assert_eq!(role_of(Some(&"vip/1,subscriber/3".to_string())), Role::Vip);
        assert_eq!(role_of(None), Role::Viewer);
    }
}
