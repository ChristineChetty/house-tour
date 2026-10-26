# House walkthrough

First-person web tour of the house (Vite + three.js). The tour files are encrypted, so the site can be
public on GitHub Pages while only people with the password can open the house.

## Run locally
```bash
npm install
npm run dev
```
The dev server reads the plaintext exports from `../export/` (no password). Add `?enc` to the URL to test
the encrypted files in `public/` instead.

Controls: drag to look, click (or tap) the floor to walk there, W/S or ↑/↓ to walk, Q/E or ←/→ to turn,
A/D to step sideways, Shift to run. Speed button (or 1/2/3) for slow/normal/fast, zoom with the wheel, pinch or
+/−. Map (M) shows the floor plan: click a room or any spot to go there. Aerial (V) shows the whole house from
above; click the ground to land. Rooms (R) lists inside and outside spots; Go outside / Go inside (O) remembers
your last spot on each side. F switches furnished/unfurnished, ? shows help. Phones: one stick (up/down walks,
left/right turns), drag to look, tap to walk, pinch to zoom.

## Encrypt and publish
```bash
npm run encrypt
```
Type the tour password at the hidden prompt (it is never saved). This writes `public/models/*.glb.enc` and
`public/spawns.json.enc`. Commit those; `.gitignore` keeps every plaintext model out of the repo.
Pushing to `main` deploys with `.github/workflows/pages.yml` (repo Settings → Pages → Source: GitHub Actions).

What the password protects: the house models and room list. The page code itself is public. Use four or more
random words. To revoke access, run `npm run encrypt` with a new password and push again.
