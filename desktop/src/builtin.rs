
pub const LASTFM_KEY: &str = match option_env!("CADENZA_LASTFM_KEY") { Some(k) => k, None => "" };
pub const DISCORD_APP_ID: &str = match option_env!("CADENZA_DISCORD_APP_ID") { Some(k) => k, None => "1560823834800558130" };
