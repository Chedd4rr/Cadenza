# How autoplay and the taste profile work

The short version is in the [README](../README.md#autoplay-and-your-taste). This is the long one. The
code is the `Taste` and `Radio` objects in `Resources/web/app.js`; the profile is saved in
`~/Library/Application Support/Cadenza/taste.json`.

## Finding songs

When you play a song on its own (from Search, a song's menu, a link), or an album or playlist ends,
autoplay starts a session from that song.

- **Similar songs** come from Last.fm's "people who play this also play" data for the song, plus the
  last couple of songs heard in this session (the newest counts most). Without Last.fm, or when it knows
  too little, they come from Spotify's search: more by the artist, their collaborators and their genres.
- **Similar artists:** when most of what was found is by the same artist, autoplay also adds a
  well-known song each by up to six artists Last.fm calls similar, so it moves on early.
- **A song you pick sets the direction.** Only songs heard since you picked it steer the session; what
  you played before was another mood. When an album or playlist runs out, its last few songs count too.
- **Never twice:** no song you've heard in the last 24 hours (in any version: single, album cut,
  remaster), and no song twice in one session.
- **Artists spaced out:** the same artist at most once in any four songs in a row. The artist you started
  from gets one more song in the first three, then at most one in six.
- Autoplay keeps the next four songs in Spotify's queue so skipping fast never runs it dry, and only
  queues once Spotify confirms the song is playing (queueing earlier can put a song in twice). A song
  that already played and comes round again from Spotify's queue is skipped.

## Ranking

Every song found gets a score from seven things, each between −1 and +1:

| Factor | What it measures | Starting weight |
|---|---|---|
| How close a match | Last.fm's similarity to what's playing | 1.0 |
| The artist | Your artist score (below) | 1.2 |
| The style | Your scores for the artist's styles | 0.8 |
| Time of day | Whether you play this artist or style more at this time than usual | 0.4 |
| Songs you love | Your score for this exact song | 0.2 |
| Heard a lot lately | The same song in the last 6 hours, or the artist several times in 2 hours | −1.0 |
| New artists | An artist you've barely heard | 0 |

The weights are learned: each time autoplay's pick is finished or skipped, the weights that would have
predicted that better move a little that way (online logistic regression), gently pulled back towards
their starting values so a few odd days can't wreck them. The Taste page shows the current weights.

Every sixth place goes to the best new artist on the list, in a style you don't avoid, so autoplay keeps
discovering. The Queue page says why each autoplay song is there.

## What it learns from

| You… | Counts as |
|---|---|
| Finish a song | +1 (+1.5 when you play it again within a day, +0.5 more if you picked it) |
| Listen past half | +0.2 |
| Skip in the first 30 seconds | −1 for an autoplay pick, −0.3 for a song in a list, −0.2 for one you picked |
| Skip before half | −0.5 for an autoplay pick, −0.15 otherwise |
| Like / unlike a song | +2 / −1 |
| Add a song to a playlist / the builder | +2 / +1 |
| More like this / Less like this | +2 / −2 (and the song is left out for 90 days) |

A skip that came because you started something else counts half. A song Spotify refused to play
counts as nothing. A song autoplay offered that you skipped fast twice is left out for a month.

### Your past

After an import (or H on the Taste page), the profile learns from your Spotify history and the Last.fm
scrobbles after it. That part is kept separate and rebuilt from scratch each time, so nothing counts
twice, and it counts a quarter as much as what you do now.

- A finished play +1 (+1.3 if you picked it), any other play of 30 seconds or more +0.5.
- A skip counts more the sooner it came: under a second −0.2, under 10 seconds −0.6, under 30 −0.4,
  under a minute −0.2, later −0.1. Halved if you'd moved on to something else, or picked it yourself.
- Plays that ended because you pressed back, the app quit or the song failed count as no verdict.
- With no history and no scrobbles, your Last.fm top artists and songs of the past year are used.

## Scores

Everything is kept as counters per artist, song, style and time of day, for what Cadenza saw and for
what it learned from your past. Each counter remembers how much you kept, how much you skipped, how many
plays are behind it, how many months you kept listening and how much lately.

- **Fading:** everything loses half its weight every 90 days, so the profile follows you.
- **Proportional:** a score compares the share you keep with your usual share for that kind of thing.
  A style you play all the time also gets skipped a lot (you skip through it to reach other songs in
  it); that's normal for you, so it counts as neutral, not a dislike.
- **Plays behind it:** scaled by plays / (plays + 8), so a couple of plays can't put anything at the top.
- **Binges:** plays bunched into one week count less each (the k-th one 1/√k), and a song or style you
  played 5+ times in a week then left for over a month loses weight the longer you stay away.

### Artists

On top of the proportional score, an artist's score counts:

- **Breadth:** how many different songs of theirs you've kept at least twice. 1 song gives a quarter,
  3 half, 10 three quarters. One favourite song says you like the song, not the artist.
- **How long:** each calendar month you keep listening adds up (months fade by half over a year), so an
  artist you've played for years outranks one you just found.
- **Your playlists:** how many of your own playlists (and Liked Songs) have their songs. Read slowly in
  the background, a little after launch and every six hours, and only again when a playlist changes.
- **Styles you like:** a small nudge, never a penalty.
- **Lately:** a boost from the last couple of weeks that wears off. On the Taste page it's the lighter,
  dashed end of the bar.
- **Few songs:** a liking that rests on 1–3 songs you keep (×0.65 / 0.75 / 0.85) or 1–3 songs across
  your playlists (×0.75 / 0.85 / 0.95) counts for less.

### Styles

Styles come from Last.fm's artist tags (or Spotify's genres when Cadenza already has them). Only tags
that are a kind of music count: countries, cities, nationalities, languages and things like "seen live"
are left out. A style is scored like an artist, with artists in the place of songs: how many different
artists you like in it, how long you've stuck with it, how many playlists have artists in it, lately
(counted across artists), and a style that rests on 1–3 artists is scaled down. One band you play
constantly can't make its tags your styles.

## Correcting it

On the Taste page:

- **X** on an artist, song or style takes it out: what was learned about it stops counting, also from
  your imported history when it's relearned. What you do from now on counts again.
- **+ / −** marks an artist you love or hate. Your mark replaces their score, and hated artists are
  never autoplayed. A song's menu has the same, plus "Never autoplay [artist]".
- **Tab** goes to the controls: mark an artist by name, learn from your history, let banned artists and
  songs back, or forget everything.
