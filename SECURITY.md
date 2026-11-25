# Security

If you find a security problem in Cadenza, please don't open a public issue. Report it privately
through GitHub instead: the repo's Security tab → "Report a vulnerability". I'll reply as soon as I can.

What's worth reporting:

- Anything that lets a web page, song or playlist data, or another app run code in Cadenza or reach
  its native commands.
- Anything that leaks your Spotify login, Last.fm or Genius keys, or other files.
- Ways to get an update installed that wasn't signed with the same certificate as the app.

Cadenza keeps your keys in `~/Library/Application Support/Cadenza/secrets.json` (readable only by
you) and librespot's login in the `librespot` folder next to it. Neither is ever part of this repo.
The bundled librespot is built from source at a pinned commit, and its dependencies are locked by
librespot's `Cargo.lock`.
