//! YouTube live chat, read the way YouTube's own chat page reads it.
//!
//! The popout chat page carries the API key, client version, and a
//! continuation token; `youtubei/v1/live_chat/get_live_chat` then answers
//! each continuation with new chat actions and the next token. No sign-in,
//! and far lighter than running YouTube's chat application in a window.

use std::{
    collections::{HashSet, VecDeque},
    sync::OnceLock,
    time::Duration,
};

use serde_json::{json, Value};

use super::message::{now_ms, safe_image, tidy, ChatEvent, ChatMessage, Highlight, Part, Role};
use super::source::{Platform, SourceSpec};
use super::{deliver, set_state, SourceState};

const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";

pub fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .timeout(Duration::from_secs(15))
            .build()
            .unwrap_or_default()
    })
}

#[derive(Debug, Clone, PartialEq)]
pub struct Session {
    pub api_key: String,
    pub client_version: String,
    pub continuation: String,
}

/// Why a chat cannot be followed, in words for the person.
fn page_problem(html: &str) -> String {
    if html.contains("Chat is disabled") {
        "Chat is turned off for this stream.".into()
    } else if html.contains("is not available") || html.contains("unavailable") {
        "This stream's chat is not available.".into()
    } else {
        "This video has no live chat right now.".into()
    }
}

fn between<'a>(text: &'a str, start: &str, end: &str) -> Option<&'a str> {
    let from = text.find(start)? + start.len();
    let to = text[from..].find(end)? + from;
    Some(&text[from..to])
}

/// The popout chat page: its keys, and the continuation for the chosen view.
pub fn parse_page(html: &str, top_chat: bool) -> Result<Session, String> {
    let api_key = between(html, "\"INNERTUBE_API_KEY\":\"", "\"").map(str::to_string);
    let client_version =
        between(html, "\"INNERTUBE_CONTEXT_CLIENT_VERSION\":\"", "\"").map(str::to_string);

    let data = ["window[\"ytInitialData\"] = ", "var ytInitialData = "]
        .iter()
        .find_map(|marker| between(html, marker, ";</script>"))
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok());

    let renderer = data
        .as_ref()
        .and_then(|d| d.pointer("/contents/liveChatRenderer"))
        .ok_or_else(|| page_problem(html))?;

    // The view selector offers "Top chat" (0) and "Live chat" (1), each with
    // its own continuation; the plain one is whichever YouTube defaults to.
    let from_menu = renderer
        .pointer(
            "/header/liveChatHeaderRenderer/viewSelector/sortFilterSubMenuRenderer/subMenuItems",
        )
        .and_then(Value::as_array)
        .and_then(|items| items.get(if top_chat { 0 } else { 1 }))
        .and_then(|item| item.pointer("/continuation/reloadContinuationData/continuation"))
        .and_then(Value::as_str);
    let plain = renderer
        .pointer("/continuations/0")
        .and_then(continuation_of)
        .map(|(token, _)| token);

    let continuation = from_menu
        .map(str::to_string)
        .or(plain)
        .ok_or_else(|| page_problem(html))?;

    Ok(Session {
        api_key: api_key.ok_or("YouTube's chat page has changed shape.")?,
        client_version: client_version.unwrap_or_else(|| "2.20260918.00.00".into()),
        continuation,
    })
}

/// `(token, timeout_ms)` from any of YouTube's continuation kinds.
fn continuation_of(value: &Value) -> Option<(String, u64)> {
    [
        "invalidationContinuationData",
        "timedContinuationData",
        "reloadContinuationData",
        "liveChatReplayContinuationData",
    ]
    .iter()
    .find_map(|kind| value.get(*kind))
    .and_then(|data| {
        let token = data.get("continuation")?.as_str()?.to_string();
        let timeout = data
            .get("timeoutMs")
            .and_then(Value::as_u64)
            .unwrap_or(2500);
        Some((token, timeout))
    })
}

fn text_of(value: Option<&Value>) -> String {
    let Some(value) = value else {
        return String::new();
    };
    if let Some(simple) = value.get("simpleText").and_then(Value::as_str) {
        return simple.to_string();
    }
    value
        .get("runs")
        .and_then(Value::as_array)
        .map(|runs| {
            runs.iter()
                .filter_map(|run| run.get("text").and_then(Value::as_str))
                .collect::<String>()
        })
        .unwrap_or_default()
}

fn thumbnail(value: Option<&Value>) -> Option<String> {
    value?
        .get("thumbnails")?
        .as_array()?
        .last()?
        .get("url")?
        .as_str()
        .and_then(safe_image)
}

fn parts_of(message: Option<&Value>) -> Vec<Part> {
    let Some(runs) = message
        .and_then(|m| m.get("runs"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    let parts = runs
        .iter()
        .filter_map(|run| {
            if let Some(text) = run.get("text").and_then(Value::as_str) {
                return Some(Part::Text {
                    text: text.to_string(),
                });
            }
            let emoji = run.get("emoji")?;
            let alt = emoji
                .pointer("/shortcuts/0")
                .or_else(|| emoji.get("emojiId"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            match thumbnail(emoji.get("image")) {
                Some(url) => Some(Part::Emote { url, alt }),
                // Plain Unicode emoji carry their character as the id.
                None => Some(Part::Text { text: alt }),
            }
        })
        .collect();
    tidy(parts)
}

fn argb_to_hex(value: Option<&Value>) -> Option<String> {
    let argb = value?.as_i64()? as u32;
    Some(format!("#{:06x}", argb & 0x00ff_ffff))
}

/// Owner, moderator, member, from the badges YouTube attaches.
fn role_and_badges(renderer: &Value) -> (Role, Vec<String>) {
    let mut role = Role::Viewer;
    let mut images = Vec::new();
    for badge in renderer
        .get("authorBadges")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let badge = &badge["liveChatAuthorBadgeRenderer"];
        match badge.pointer("/icon/iconType").and_then(Value::as_str) {
            Some("OWNER") => role = Role::Owner,
            Some("MODERATOR") if role != Role::Owner => role = Role::Moderator,
            _ => {}
        }
        if let Some(url) = thumbnail(badge.get("customThumbnail")) {
            if role == Role::Viewer {
                role = Role::Member;
            }
            images.push(url);
        }
    }
    (role, images)
}

fn timestamp(renderer: &Value) -> u64 {
    renderer
        .get("timestampUsec")
        .and_then(Value::as_str)
        .and_then(|usec| usec.parse::<u64>().ok())
        .map(|usec| usec / 1000)
        .unwrap_or_else(now_ms)
}

/// One chat item, if it is something worth showing.
pub fn message_from_item(item: &Value, source: &str) -> Option<ChatMessage> {
    let (kind, renderer) = item.as_object()?.iter().next()?;
    let highlight = match kind.as_str() {
        "liveChatTextMessageRenderer" => None,
        "liveChatPaidMessageRenderer" | "liveChatPaidStickerRenderer" => Some(Highlight {
            label: text_of(renderer.get("purchaseAmountText")),
            color: argb_to_hex(
                renderer
                    .get("bodyBackgroundColor")
                    .or_else(|| renderer.get("backgroundColor")),
            ),
        }),
        "liveChatMembershipItemRenderer" => Some(Highlight {
            label: {
                let header = text_of(renderer.get("headerPrimaryText"));
                if header.is_empty() {
                    text_of(renderer.get("headerSubtext"))
                } else {
                    header
                }
            },
            color: Some("#0f9d58".into()),
        }),
        _ => return None,
    };

    let id = renderer.get("id")?.as_str()?.to_string();
    let author = text_of(renderer.get("authorName"));
    let (role, badges) = role_and_badges(renderer);
    let mut parts = parts_of(renderer.get("message"));
    if kind == "liveChatPaidStickerRenderer" {
        if let Some(url) = thumbnail(renderer.get("sticker")) {
            parts.push(Part::Emote {
                url,
                alt: "sticker".into(),
            });
        }
    }
    if parts.is_empty() && highlight.is_none() {
        return None;
    }

    Some(ChatMessage {
        id,
        source: source.to_string(),
        platform: Platform::Youtube,
        author: if author.is_empty() {
            "YouTube".into()
        } else {
            author
        },
        author_id: renderer
            .get("authorExternalChannelId")
            .and_then(Value::as_str)
            .map(str::to_string),
        author_color: None,
        avatar: thumbnail(renderer.get("authorPhoto")),
        role,
        badges,
        parts,
        highlight,
        at: timestamp(renderer),
    })
}

/// A `get_live_chat` answer: the events in it, and where to go next. `None`
/// when the answer is not a chat at all, which is a hiccup to retry, not the
/// end of the stream.
pub fn parse_response(
    body: &Value,
    source: &str,
) -> Option<(Vec<ChatEvent>, Option<(String, u64)>)> {
    let chat = body.pointer("/continuationContents/liveChatContinuation")?;
    let events = chat
        .get("actions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|action| {
            if let Some(item) = action.pointer("/addChatItemAction/item") {
                return message_from_item(item, source).map(ChatEvent::Message);
            }
            if let Some(author) = action
                .pointer("/removeChatItemByAuthorAction/externalChannelId")
                .and_then(Value::as_str)
            {
                return Some(ChatEvent::RemoveAuthor(author.to_string()));
            }
            let removed = action
                .pointer("/markChatItemAsDeletedAction/targetItemId")
                .or_else(|| action.pointer("/removeChatItemAction/targetItemId"))?;
            removed.as_str().map(|id| ChatEvent::Remove(id.to_string()))
        })
        .collect();
    let next = chat.pointer("/continuations/0").and_then(continuation_of);
    Some((events, next))
}

/// How long to wait before asking again. YouTube's own timeouts assume a push
/// channel we do not have; a short, bounded poll keeps chat live without
/// hammering anything.
fn poll_delay(timeout_ms: u64) -> Duration {
    Duration::from_millis(timeout_ms.clamp(1500, 2500))
}

async fn open(spec: &SourceSpec) -> Result<Session, String> {
    let html = client()
        .get(format!(
            "https://www.youtube.com/live_chat?is_popout=1&v={}",
            spec.id
        ))
        .header("Accept-Language", "en")
        .header("Cookie", "SOCS=CAI; CONSENT=PENDING+987")
        .send()
        .await
        .map_err(|e| format!("Could not reach YouTube: {e}"))?
        .text()
        .await
        .map_err(|e| e.to_string())?;
    parse_page(&html, spec.top_chat)
}

async fn fetch(session: &Session) -> Result<Value, String> {
    let response = client()
        .post(format!(
            "https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key={}&prettyPrint=false",
            session.api_key
        ))
        .json(&json!({
            "context": { "client": { "clientName": "WEB", "clientVersion": session.client_version, "hl": "en" } },
            "continuation": session.continuation,
        }))
        .send()
        .await
        .map_err(|e| format!("Could not reach YouTube: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("YouTube answered {}", response.status()));
    }
    response.json().await.map_err(|e| e.to_string())
}

/// Follows one YouTube chat until the task is aborted or the chat ends.
pub async fn run(spec: SourceSpec) {
    let key = spec.key();
    let mut seen: VecDeque<String> = VecDeque::with_capacity(600);
    let mut seen_set: HashSet<String> = HashSet::new();
    let mut failures = 0u32;

    'session: loop {
        set_state(&key, SourceState::Connecting, None);
        let mut session = match open(&spec).await {
            Ok(session) => session,
            Err(error) => {
                failures += 1;
                set_state(&key, SourceState::Error, Some(error));
                tokio::time::sleep(backoff(failures)).await;
                continue 'session;
            }
        };

        loop {
            let answer = fetch(&session).await.and_then(|body| {
                parse_response(&body, &key)
                    .ok_or_else(|| "YouTube sent an answer without chat in it.".to_string())
            });
            match answer {
                Ok((events, next)) => {
                    failures = 0;
                    let fresh: Vec<ChatEvent> = events
                        .into_iter()
                        .filter(|event| match event {
                            ChatEvent::Message(message) => {
                                if seen_set.contains(&message.id) {
                                    return false;
                                }
                                seen_set.insert(message.id.clone());
                                seen.push_back(message.id.clone());
                                if seen.len() > 500 {
                                    if let Some(old) = seen.pop_front() {
                                        seen_set.remove(&old);
                                    }
                                }
                                true
                            }
                            _ => true,
                        })
                        .collect();
                    set_state(&key, SourceState::Live, None);
                    if !fresh.is_empty() {
                        deliver(&key, fresh);
                    }
                    match next {
                        Some((token, timeout)) => {
                            session.continuation = token;
                            tokio::time::sleep(poll_delay(timeout)).await;
                        }
                        None => {
                            set_state(
                                &key,
                                SourceState::Ended,
                                Some("The stream has ended.".into()),
                            );
                            return;
                        }
                    }
                }
                Err(error) => {
                    failures += 1;
                    set_state(&key, SourceState::Error, Some(error));
                    tokio::time::sleep(backoff(failures)).await;
                    // After a few misses, start over from the page: the
                    // continuation may simply have gone stale.
                    if failures >= 3 {
                        continue 'session;
                    }
                }
            }
        }
    }
}

pub fn backoff(failures: u32) -> Duration {
    Duration::from_secs(match failures {
        0 | 1 => 3,
        2 => 8,
        3 => 20,
        _ => 45,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: &str = r#"<script>ytcfg.set({"INNERTUBE_API_KEY":"KEY123","INNERTUBE_CONTEXT_CLIENT_VERSION":"2.2026"});</script><script nonce="x">window["ytInitialData"] = {"contents":{"liveChatRenderer":{"continuations":[{"invalidationContinuationData":{"continuation":"PLAIN","timeoutMs":10000}}],"header":{"liveChatHeaderRenderer":{"viewSelector":{"sortFilterSubMenuRenderer":{"subMenuItems":[{"title":"Top chat","continuation":{"reloadContinuationData":{"continuation":"TOP"}}},{"title":"Live chat","continuation":{"reloadContinuationData":{"continuation":"ALL"}}}]}}}}}}};</script>"#;

    #[test]
    fn reads_the_page_and_picks_the_view() {
        let all = parse_page(PAGE, false).unwrap();
        assert_eq!(all.api_key, "KEY123");
        assert_eq!(all.client_version, "2.2026");
        assert_eq!(all.continuation, "ALL");
        assert_eq!(parse_page(PAGE, true).unwrap().continuation, "TOP");
    }

    #[test]
    fn explains_pages_without_chat() {
        let disabled = r#"window["ytInitialData"] = {"contents":{"messageRenderer":{"text":{"runs":[{"text":"Chat is disabled for this live stream."}]}}}};</script>"#;
        assert_eq!(
            parse_page(disabled, false).unwrap_err(),
            "Chat is turned off for this stream."
        );
    }

    #[test]
    fn parses_messages_superchats_members_and_deletions() {
        let body: Value = serde_json::from_str(r#"{"continuationContents":{"liveChatContinuation":{
          "continuations":[{"timedContinuationData":{"continuation":"NEXT","timeoutMs":4000}}],
          "actions":[
            {"addChatItemAction":{"item":{"liveChatTextMessageRenderer":{"id":"m1","timestampUsec":"1700000000000000","authorExternalChannelId":"UCalice",
              "authorName":{"simpleText":"@alice"},
              "authorPhoto":{"thumbnails":[{"url":"https://yt4.ggpht.com/a=s32"},{"url":"https://yt4.ggpht.com/a=s64"}]},
              "authorBadges":[{"liveChatAuthorBadgeRenderer":{"icon":{"iconType":"MODERATOR"},"tooltip":"Moderator"}}],
              "message":{"runs":[{"text":"hello "},{"emoji":{"emojiId":"x","shortcuts":[":wave:"],"image":{"thumbnails":[{"url":"https://yt3.ggpht.com/wave"}]}}},{"text":" world"}]}}}}},
            {"addChatItemAction":{"item":{"liveChatPaidMessageRenderer":{"id":"m2","authorName":{"simpleText":"@bob"},
              "purchaseAmountText":{"simpleText":"$5.00"},"bodyBackgroundColor":4280191205,
              "message":{"runs":[{"text":"gg"}]}}}}},
            {"addChatItemAction":{"item":{"liveChatMembershipItemRenderer":{"id":"m3","authorName":{"simpleText":"@carol"},
              "headerSubtext":{"runs":[{"text":"Welcome to "},{"text":"Members"}]},
              "authorBadges":[{"liveChatAuthorBadgeRenderer":{"customThumbnail":{"thumbnails":[{"url":"https://yt3.ggpht.com/badge"}]},"tooltip":"New member"}}]}}}},
            {"addChatItemAction":{"item":{"liveChatViewerEngagementMessageRenderer":{"id":"sys"}}}},
            {"markChatItemAsDeletedAction":{"targetItemId":"m0"}},
            {"removeChatItemByAuthorAction":{"externalChannelId":"UCspam"}}
          ]}}}"#).unwrap();

        let (events, next) = parse_response(&body, "yt:X").unwrap();
        assert_eq!(next, Some(("NEXT".into(), 4000)));
        assert_eq!(events.len(), 5, "engagement banners are skipped");

        let ChatEvent::Message(first) = &events[0] else {
            panic!()
        };
        assert_eq!(first.author, "@alice");
        assert_eq!(first.author_id.as_deref(), Some("UCalice"));
        assert_eq!(first.role, Role::Moderator);
        assert_eq!(first.avatar.as_deref(), Some("https://yt4.ggpht.com/a=s64"));
        assert_eq!(first.at, 1_700_000_000_000);
        assert_eq!(
            first.parts,
            vec![
                Part::Text {
                    text: "hello ".into()
                },
                Part::Emote {
                    url: "https://yt3.ggpht.com/wave".into(),
                    alt: ":wave:".into()
                },
                Part::Text {
                    text: " world".into()
                },
            ]
        );

        let ChatEvent::Message(paid) = &events[1] else {
            panic!()
        };
        assert_eq!(paid.highlight.as_ref().unwrap().label, "$5.00");
        assert_eq!(
            paid.highlight.as_ref().unwrap().color.as_deref(),
            Some("#1e88e5")
        );

        let ChatEvent::Message(member) = &events[2] else {
            panic!()
        };
        assert_eq!(member.role, Role::Member);
        assert_eq!(
            member.highlight.as_ref().unwrap().label,
            "Welcome to Members"
        );
        assert_eq!(
            member.badges,
            vec!["https://yt3.ggpht.com/badge".to_string()]
        );

        assert_eq!(events[3], ChatEvent::Remove("m0".into()));
        assert_eq!(events[4], ChatEvent::RemoveAuthor("UCspam".into()));
    }

    /// An answer with no chat in it is retried; one whose chat has no next
    /// page is the stream ending.
    #[test]
    fn tells_a_hiccup_from_the_end() {
        let odd: Value = serde_json::from_str(r#"{"responseContext":{}}"#).unwrap();
        assert!(parse_response(&odd, "yt:X").is_none());
        let ended: Value = serde_json::from_str(
            r#"{"continuationContents":{"liveChatContinuation":{"actions":[]}}}"#,
        )
        .unwrap();
        let (events, next) = parse_response(&ended, "yt:X").unwrap();
        assert!(events.is_empty());
        assert_eq!(next, None);
    }

    #[test]
    fn polls_briskly_but_not_frantically() {
        assert_eq!(poll_delay(10_000), Duration::from_millis(2500));
        assert_eq!(poll_delay(100), Duration::from_millis(1500));
        assert_eq!(poll_delay(2000), Duration::from_millis(2000));
    }
}
