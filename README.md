# Snooker Shoot Out

A scoreboard and shot clock for [Snooker Shoot Out](https://en.wikipedia.org/wiki/Snooker_Shoot_Out) frames.
Static HTML/CSS/JS: no build step, no server, no database. Deploys to Vercel as-is.

## Features

- 10-minute frame clock; shot clock of 15 s for the first 5 minutes and 10 s after (all configurable)
- Independent clocks: the frame clock keeps running between shots while the shot clock waits.
  Tap the shot clock to start/stop it (or set it to auto-start N seconds after each shot);
  tap the frame clock to stop/restart frame time; Pause freezes both
- Adjust the frame clock (±10 s / ±1 min) from the menu
- Beeps and vibration for the last 5 seconds of the shot clock
- Pot buttons (1–7), current break, End turn, Foul (4–7 points → opponent, ball in hand), Undo
- Time-foul prompt when the shot clock runs out
- "Time's up" screen to record the last pot, then the winner; ties go to a blue-ball shoot-out
- Keeps the screen awake, survives a page reload, installs as a home-screen app
- Keyboard: `1`–`7` pot · `Space` start/stop shot clock · `Enter` end turn · `M` frame clock · `F` foul · `Z` undo · `P` pause

## Run locally

```sh
cd public && python3 -m http.server 8000
```

## Deploy

Import the repo in Vercel. `vercel.json` serves the `public/` folder, so no framework preset is needed.
