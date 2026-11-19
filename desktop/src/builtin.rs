//! Keys that ship with Cadenza, so nobody has to make their own: Cadenza's Last.fm API key (every Last.fm
//! call Cadenza makes reads public data, so the key isn't a secret) and its Discord application ID (also
//! public: it's what Discord shows as "Listening to Cadenza"). Your own, set on the System page, win.
//!
//! A fork can build with its own instead: CADENZA_LASTFM_KEY=… CADENZA_DISCORD_APP_ID=… ./build.sh
//! (Spotify can't work this way: since 2026 a Spotify developer app is limited to 5 users, so everyone
//! makes their own; the setup screen walks through it.)

pub const LASTFM_KEY: &str = match option_env!("CADENZA_LASTFM_KEY") { Some(k) => k, None => "178be612ec98688e40582603a209fc8e" };
pub const DISCORD_APP_ID: &str = match option_env!("CADENZA_DISCORD_APP_ID") { Some(k) => k, None => "1560823834800558130" };
