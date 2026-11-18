# Stats and the Spotify history import

The short version is in the [README](../README.md#stats-and-your-spotify-history).

## Sources

The Stats page (S switches between them):

- **ALL** puts everything together, each play counted once:
  1. your imported Spotify history;
  2. then everything scrobbled to Last.fm after it ends (if Last.fm is connected), so plays from your
     phone or the Spotify app show up too. Cadenza keeps these in `lastfm-plays.json` and only asks
     Last.fm for new ones, at most every 10 minutes. The first time it fetches everything since the
     import ends (or your whole Last.fm history if nothing is imported), which can take a minute or two;
  3. then anything Cadenza played after it that Last.fm doesn't have (Last.fm was down, or Spotify
     scrobbling isn't linked). A Cadenza play counts as the same play when Last.fm has that song within
     10 minutes.
- **LAST.FM CHARTS**: Last.fm's own top artists and songs.
- **CADENZA**: only what Cadenza played.

Last.fm doesn't say how long you listened, so a scrobble counts for that song's usual length from your
other plays (or 3.5 minutes) in "hours listened". The same song scrobbled twice within 90 seconds counts
once.

## The import

Request **Extended streaming history** at
[spotify.com/account/privacy](https://www.spotify.com/account/privacy/), then press I on the Stats page
and pick the .zip Spotify sends, the folder inside it, or the `Streaming_History_Audio_….json` files.
The shorter "Account data" download (`StreamingHistory_music_….json`) works too, without skip details.

- **No duplicates:** a play is matched by the minute it ended plus the song's name and artist, so
  importing the same files again, or an overlapping newer download, only adds what's new. It works
  across both kinds of download.
- **What counts:** a play counts in Stats from 30 seconds, like on Spotify. Shorter plays are kept too
  (plays under a second only if you skipped them), with how each started and ended (skipped, finished,
  picked by you, ended because you played something else, or ended for a reason that says nothing about
  the song). The taste profile learns from those; Stats leaves them out. Importing files you imported
  with an older Cadenza adds these details to the plays already there.
- **What's kept:** only the time, length, song, artist, album, song link and those details, in
  `spotify-history.json`. IP addresses, countries and devices are never saved, and nothing is uploaded.
- **Safety:** a .zip is checked before it's unpacked (no paths that escape the folder, at most 5,000
  files and 2 GB), and each file is read only if it looks like Spotify's history.
- ⌘K → "Remove imported Spotify history" deletes it again.
