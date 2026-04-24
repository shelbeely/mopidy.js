---
name: mopidy-js
description: Use the mopidy.js library to control a Mopidy music server from JavaScript or TypeScript. Covers installation, connecting via WebSocket, calling playback/tracklist/library/mixer/history API methods, handling server-pushed events, and cleaning up. Use this skill when writing Node.js, Bun, or browser code that needs to control music playback on a Mopidy server.
license: Apache-2.0
compatibility: Node.js >=18, Bun >=1.0, or any modern browser. Requires a running Mopidy server (>=0.19.0) with its HTTP/WebSocket frontend enabled (default port 6680).
---

# Mopidy.js

Mopidy.js is a JavaScript/TypeScript library that exposes the full
[Mopidy core API](https://docs.mopidy.com/en/latest/api/core/) over
JSON-RPC on a WebSocket. It works in Node.js, Bun, and browsers with no
external dependencies.

## Installation

```sh
bun add mopidy
# or
npm install mopidy
```

## Connecting

```typescript
import Mopidy from "mopidy";

const mopidy = new Mopidy({
  webSocketUrl: "ws://localhost:6680/mopidy/ws/",
});
```

The instance connects immediately by default. To defer the connection:

```typescript
const mopidy = new Mopidy({ autoConnect: false });
mopidy.on("state:online", () => { /* safe to call API methods now */ });
mopidy.connect();
```

### Constructor options

| Option             | Default                         | Description                                      |
| ------------------ | ------------------------------- | ------------------------------------------------ |
| `webSocketUrl`     | `ws://<host>/mopidy/ws`         | WebSocket endpoint                               |
| `autoConnect`      | `true`                          | Connect on construction                          |
| `backoffDelayMin`  | `1000`                          | Min reconnect delay (ms)                         |
| `backoffDelayMax`  | `64000`                         | Max reconnect delay (ms)                         |
| `webSocket`        | `undefined`                     | Provide an existing WebSocket object             |
| `console`          | `console`                       | Logger object (useful in tests)                  |

## Calling API methods

Every method returns a `Promise`. Only call methods after `state:online` fires;
earlier calls throw `Mopidy.ConnectionError`.

```typescript
mopidy.on("state:online", async () => {
  // --- Playback ---
  const state = await mopidy.playback!.getState(); // "playing" | "paused" | "stopped"
  const track = await mopidy.playback!.getCurrentTrack();
  const pos   = await mopidy.playback!.getTimePosition(); // ms

  await mopidy.playback!.play();
  await mopidy.playback!.pause();
  await mopidy.playback!.stop();
  await mopidy.playback!.next();
  await mopidy.playback!.previous();
  await mopidy.playback!.seek({ time_position: 30_000 }); // ms

  // --- Tracklist ---
  await mopidy.tracklist!.add({ uris: ["spotify:track:4uLU6hMCjMI75M1A2tKUQC"] });
  await mopidy.tracklist!.clear();
  const tracks = await mopidy.tracklist!.getTracks();
  await mopidy.tracklist!.setRandom({ value: true });
  await mopidy.tracklist!.setRepeat({ value: false });

  // --- Library ---
  const results  = await mopidy.library!.search({ query: { any: ["radiohead"] } });
  const resolved = await mopidy.library!.lookup({ uris: ["spotify:track:xxx"] });
  const items    = await mopidy.library!.browse({ uri: "spotify:user:spotify:playlist:37i9dQZF1DXcBWIGoYBM5M" });

  // --- Playlists ---
  const playlists = await mopidy.playlists!.asList();

  // --- Mixer ---
  const volume = await mopidy.mixer!.getVolume();
  await mopidy.mixer!.setVolume({ volume: 80 }); // 0–100

  // --- History ---
  const history = await mopidy.history!.getHistory();
});
```

## Argument style

JSON-RPC 2.0 allows either by-position (array) or by-name (object) arguments.
By-name is strongly preferred — it is self-documenting and immune to argument-order bugs:

```typescript
// ✅ By-name (recommended)
mopidy.library!.search({ query: { any: ["abba"] }, exact: false });

// ⚠️  By-position (valid, but opaque)
mopidy.library!.search([{ any: ["abba"] }, null, false]);
```

## Handling events

```typescript
// Connection lifecycle
mopidy.on("state:online",         () => console.log("ready"));
mopidy.on("state:offline",        () => console.log("offline"));
mopidy.on("reconnectionPending",  ({ timeToAttempt }) => {});
mopidy.on("reconnecting",         () => {});

// Server-pushed events (all prefixed "event:")
mopidy.on("event:trackPlaybackStarted",  ({ tl_track }) => {});
mopidy.on("event:trackPlaybackPaused",   ({ tl_track, time_position }) => {});
mopidy.on("event:trackPlaybackStopped",  ({ tl_track, time_position }) => {});
mopidy.on("event:playbackStateChanged",  ({ old_state, new_state }) => {});
mopidy.on("event:volumeChanged",         ({ volume }) => {});
mopidy.on("event:tracklistChanged",      () => {});
mopidy.on("event:playlistsLoaded",       () => {});

// Catch-all aggregates (receive every member event)
mopidy.on("state", console.log);
mopidy.on("event", console.log);

// Introspect WebSocket traffic
mopidy.on("websocket:open",             () => {});
mopidy.on("websocket:close",            () => {});
mopidy.on("websocket:error",            (event) => {});
mopidy.on("websocket:incomingMessage",  ({ data }) => {});
mopidy.on("websocket:outgoingMessage",  ({ data }) => {});
```

## Error handling

```typescript
try {
  await mopidy.playback!.play();
} catch (err) {
  if (err instanceof Mopidy.ConnectionError) {
    // Called before state:online, or after disconnect
  }
  // Mopidy.ServerError for failures returned by the server
}
```

## Cleanup

```typescript
mopidy.close(); // Close WebSocket; will NOT reconnect
mopidy.off();   // Remove all event listeners (prevents memory leaks)
```

## API discovery at runtime

Every method on `mopidy.*` exposes its Python parameter schema and docstring:

```typescript
console.log(mopidy.playback!.next.params);
console.log(mopidy.playback!.next.description);
```

## TypeScript types

Model types live under `Mopidy.models`:

```typescript
import Mopidy from "mopidy";

const track: Mopidy.models.Track      = { ... };
const artist: Mopidy.models.Artist    = { ... };
const album: Mopidy.models.Album      = { ... };
const tlTrack: Mopidy.models.TlTrack  = { ... };
```

See [references/API.md](references/API.md) for the full model and namespace reference.
