//! IDs that ship with Cadenza: its Discord application ID (public: it's what Discord shows as "Listening
//! to Cadenza"). Your own, set on the System page, wins.
//!
//! Last.fm: everyone uses their own free API key (System → Connections). A key shared by every copy gets
//! suspended by Last.fm sooner or later, which turns Last.fm off for everyone at once. A private build can
//! still bake one in: CADENZA_LASTFM_KEY=… ./build.sh (and CADENZA_DISCORD_APP_ID=… for its own Discord app).
//! (Spotify can't work this way: since 2026 a Spotify developer app is limited to 5 users, so everyone
//! makes their own; the setup screen walks through it.)

pub const LASTFM_KEY: &str = match option_env!("CADENZA_LASTFM_KEY") { Some(k) => k, None => "" };
pub const DISCORD_APP_ID: &str = match option_env!("CADENZA_DISCORD_APP_ID") { Some(k) => k, None => "1560823834800558130" };
