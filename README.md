# MLB Scores PWA

A small mobile-first MLB scoreboard that shows games for a selected date in US Central Time.

## Features

- Live MLB scores from the public MLB Stats API
- Defaults to today's Central Time date
- Date picker with previous and next day controls
- Live, upcoming, and final game grouping
- Inning/status display
- PWA manifest and service worker

## Local Preview

```bash
python3 -m http.server 4173
```

Then open `http://localhost:4173`.

Vercel serves the app from `public/` so browser JavaScript is treated as static assets, not Node functions.
