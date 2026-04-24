# Mopidy.js API Reference

## API namespaces

| Namespace            | Key methods                                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `mopidy.playback`    | `play`, `pause`, `stop`, `next`, `previous`, `seek`, `getCurrentTrack`, `getState`, `getTimePosition`                 |
| `mopidy.tracklist`   | `add`, `remove`, `clear`, `move`, `shuffle`, `getTracks`, `getLength`, `index`, `filter`, `eotTlid`, `nextTrack`, `previousTrack`, `getRepeat`, `setRepeat`, `getRandom`, `setRandom`, `getSingle`, `setSingle`, `getConsume`, `setConsume`, `getVersion` |
| `mopidy.library`     | `search`, `lookup`, `browse`, `refresh`, `getImages`, `getDistinct`                                                    |
| `mopidy.playlists`   | `asList`, `lookup`, `save`, `create`, `delete`, `getItems`, `refresh`                                                  |
| `mopidy.mixer`       | `getVolume`, `setVolume`, `getMute`, `setMute`                                                                         |
| `mopidy.history`     | `getHistory`                                                                                                           |

## Model types (`Mopidy.models.*`)

### `Track`

```typescript
interface Track {
  uri: string;
  name: string;
  artists: Artist[];
  album: Album;
  composers: Artist[];
  performers: Artist[];
  genre: string | null;
  track_no: number | null;
  disc_no: number | null;
  date: string | null;       // "YYYY" or "YYYY-MM-DD"
  length: number | null;     // ms
  bitrate: number | null;
  comment: string | null;
  musicbrainz_id: string | null;
  last_modified: number | null;
}
```

### `Artist`

```typescript
interface Artist {
  uri: string;
  name: string;
  sortname: string | null;
  musicbrainz_id: string | null;
}
```

### `Album`

```typescript
interface Album {
  uri: string;
  name: string;
  artists: Artist[];
  num_tracks: number | null;
  num_discs: number | null;
  date: string | null;
  musicbrainz_id: string | null;
  images: string[];
}
```

### `TlTrack` (tracklist entry)

```typescript
interface TlTrack {
  tlid: number;   // Unique tracklist ID for this slot
  track: Track;
}
```

### `Ref` (library browse result)

```typescript
interface Ref {
  uri: string;
  name: string;
  type: "album" | "artist" | "directory" | "playlist" | "track";
}
```

### `Playlist`

```typescript
interface Playlist {
  uri: string;
  name: string;
  tracks: Track[];
  last_modified: number | null;
}
```

### `SearchResult`

```typescript
interface SearchResult {
  uri: string;
  tracks: Track[];
  artists: Artist[];
  albums: Album[];
}
```

### `Image`

```typescript
interface Image {
  uri: string;
  width: number | null;
  height: number | null;
}
```

## Playback states

```
"playing" | "paused" | "stopped"
```

## Common patterns

### Get currently playing track + progress

```typescript
mopidy.on("state:online", async () => {
  const [track, state, pos] = await Promise.all([
    mopidy.playback!.getCurrentTrack(),
    mopidy.playback!.getState(),
    mopidy.playback!.getTimePosition(),
  ]);
  if (track && state === "playing") {
    const pct = Math.floor(((pos ?? 0) * 100) / (track.length ?? 1));
    console.log(`${track.artists[0]?.name} – ${track.name} (${pct}%)`);
  }
});
```

### Add tracks and play immediately

```typescript
await mopidy.tracklist!.clear();
await mopidy.tracklist!.add({ uris: ["spotify:track:4uLU6hMCjMI75M1A2tKUQC"] });
await mopidy.playback!.play();
```

### Search and queue results

```typescript
const results = await mopidy.library!.search({ query: { any: ["david bowie"] } });
const uris = results.flatMap((r) => r.tracks?.map((t) => t.uri) ?? []);
await mopidy.tracklist!.add({ uris });
```

### Volume fade-out

```typescript
let vol = (await mopidy.mixer!.getVolume()) ?? 100;
const step = setInterval(async () => {
  vol = Math.max(0, vol - 5);
  await mopidy.mixer!.setVolume({ volume: vol });
  if (vol === 0) {
    clearInterval(step);
    await mopidy.playback!.stop();
  }
}, 200);
```
