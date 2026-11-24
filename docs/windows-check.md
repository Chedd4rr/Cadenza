# Checking Cadenza on a real Windows PC

Cadenza was built and tried in a Windows 11 virtual machine (no graphics acceleration, so animations and sound
stuttered there). Before a release, spend 15 minutes on a real PC to rule out problems the VM could hide.

**Get it:** Actions → Desktop app → Run workflow → windows (or the Release workflow's draft). Download the
`Cadenza_…_x64-setup.exe` artifact. The run also runs `cargo test` on Windows: check that step is green.

**Install:** run it. "Windows protected your PC" → More info → Run anyway. It installs for your account only,
without asking for an administrator.

**Then go through this:**

- [ ] Sign in: your browser opens for Spotify, and once more for the player's own sign-in. Cadenza appears as a
      speaker in Spotify on your phone.
- [ ] Play a song, pause, skip, seek. Pause and skip respond at once. No gaps, crackle or stutter.
- [ ] Leave it playing for 30 minutes: no drop-outs. Watch Task Manager: CPU should be low, memory steady.
- [ ] Animations in each theme are smooth (the VM couldn't show this).
- [ ] EQ: turn bands and the boost up and down while playing, with no clicks or distortion. Crossfade works.
- [ ] Outputs: switch between speakers and headphones (and Bluetooth if you have it). Each keeps its own EQ.
      Unplug the headphones while playing: sound moves to the speakers without Cadenza hanging.
- [ ] Sleep and wake the PC: the music stays paused, and Cadenza still shows up in Spotify afterwards.
- [ ] Media keys and the volume/media overlay show the song and cover; play/pause/next work from the keyboard.
- [ ] Tray icon: play/pause, skip, Show Cadenza, mini player, Quit. Closing the window keeps the music going.
- [ ] Mini player floats above other windows and remembers where you put it.
- [ ] `Ctrl+Alt+P` shows and hides Cadenza from another app.
- [ ] A `cadenza://next` link (paste it into Win+R) skips the song.
- [ ] Open at login (System → Preferences) starts it when you sign in.
- [ ] High-DPI screen at 125% and 150%: nothing blurry, cut off or overlapping.
- [ ] Open it twice: the second one brings the first to the front.
- [ ] Uninstall (Settings → Apps → Cadenza): the app disappears; your data in `%APPDATA%\Cadenza` stays.
- [ ] System → Copy diagnostics: paste it somewhere and read it. No passwords, tokens, or your name in it.

Anything that fails: copy the diagnostics (⇧⌘D, or Ctrl+Shift+D) and write down what you were doing.
