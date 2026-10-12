# Rackline

Online 8-ball pool for 2 players (1v1) or 4 players (2v2), plus same-device and practice modes.
No accounts. Players type a username, share a 4-letter room code or invite link, and play in the browser.

There are no dependencies to install: the server is plain Node.js (version 18 or newer).

## Run it on your own computer

```
node server.js
```

Open http://localhost:3000 in two or more browser tabs. Each tab is a separate player.
Use the `PORT` environment variable to change the port.

## Put it on the internet (Render, free)

1. Create a free account at https://github.com and make a new repository.
2. Upload every file from this folder to it (server.js, package.json, render.yaml, the lib and public folders).
3. Create a free account at https://render.com and choose New > Web Service, then connect that repository.
4. Use these settings (they are also in render.yaml):
   - Runtime: Node
   - Build command: `npm install`
   - Start command: `node server.js`
   - Health check path: `/healthz`
5. Deploy. Render gives you an address like `https://rackline.onrender.com`.
6. Open that address on two devices, press Online, enter a name and create a room. Join from the other device with the code, or open the invite link.
7. Send the address to your friends. They only need a browser.

Other hosts that run Node work the same way (Fly.io, Railway, a small VPS). The host must support WebSockets, which all of these do.
A custom domain can be attached in the host's settings; HTTPS is handled by the host.

### Good to know

- Free Render services go to sleep after a while with no visitors. The first person to arrive then waits up to a minute for it to wake. A paid plan removes that.
- Rooms live in the server's memory. If the server restarts, open rooms are lost.
- A player who closes the tab can reopen the page within 10 minutes and resume their seat. The game waits for them.
- Each browser tab is its own player. Use two different tabs or devices to test.

## How it works

- `server.js` serves `public/index.html` and relays messages over a WebSocket at `/ws`.
  It owns the rooms and seats, and only lets the player whose turn it is send a shot.
- `lib/ws.js` is a small WebSocket implementation, so no packages are needed.
- The shooter's browser runs the physics for their shot and announces it. Every browser replays the same shot
  with fixed-step physics, then the shooter sends the final table and everyone snaps to it.
  This keeps the server tiny, but it means the game trusts players. It suits friendly games, not tournaments.

## Chat, emotes and limits

- Chat is plain text with no word filter. Messages are shown as text only, so nobody can inject code into another player's page.
- To protect the server, messages are cut at 300 characters and each player can send at most 12 per 10 seconds.
- Emotes are eight drawn icons. Players can mute chat and emotes from others on their own screen.
- Anything typed in chat is the responsibility of whoever runs the site.

## Controls

- Aim with the mouse, or the left and right arrow keys (hold Shift for fine steps).
- Drag back from the aim point and release to strike, or use the power slider and the Shoot button or Space.
- Click the cue-ball diagram to add spin.
- Press G, or use the switch under the power slider, to show or hide the aim guide line.
