// Lightweight EventEmitter that works in both browser and Node.js environments
// without depending on the Node.js `events` module.
type Listener = (...args: unknown[]) => void;

class EventEmitter {
  private _listeners: Map<string | symbol, Listener[]> = new Map();

  on(event: string | symbol, listener: Listener): this {
    const list = this._listeners.get(event);
    if (list) {
      list.push(listener);
    } else {
      this._listeners.set(event, [listener]);
    }
    return this;
  }

  removeListener(event: string | symbol, listener: Listener): this {
    const list = this._listeners.get(event);
    if (list) {
      const idx = list.indexOf(listener);
      if (idx !== -1) {
        list.splice(idx, 1);
      }
      if (list.length === 0) {
        this._listeners.delete(event);
      }
    }
    return this;
  }

  removeAllListeners(event?: string | symbol): this {
    if (event !== undefined) {
      this._listeners.delete(event);
    } else {
      this._listeners.clear();
    }
    return this;
  }

  emit(event: string | symbol, ...args: unknown[]): boolean {
    const list = this._listeners.get(event);
    if (!list || list.length === 0) return false;
    // Iterate over a copy so that listeners added/removed during emit are
    // not affected mid-loop (matches Node.js EventEmitter behaviour).
    for (const listener of list.slice()) {
      // Call each listener with `this` bound to the emitter, matching the
      // behaviour of Node.js EventEmitter.
      listener.apply(this, args);
    }
    return true;
  }
}

function snakeToCamel(name: string): string {
  return name.replace(/(_[a-z])/g, (match) =>
    match.toUpperCase().replace("_", "")
  );
}

class ConnectionError extends Error {
  closeEvent?: unknown;
  constructor(message: string) {
    super(message);
    this.name = "ConnectionError";
  }
}

class ServerError extends Error {
  code?: number;
  data?: unknown;
  constructor(message: string) {
    super(message);
    this.name = "ServerError";
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface MopidyEventMessage {
  event: string;
  [key: string]: unknown;
}

class Mopidy extends EventEmitter {
  /**
   * Reference to the WebSocket constructor used to open new connections.
   * Defaults to the platform-native global `WebSocket`. Tests and advanced
   * users may override this property to inject a different implementation.
   */
  static WebSocket: typeof WebSocket = (
    globalThis as { WebSocket?: typeof WebSocket }
  ).WebSocket as typeof WebSocket;

  static ConnectionError = ConnectionError;
  static ServerError = ServerError;

  _console: Console;
  _settings: Required<Mopidy.Options>;
  _backoffDelay: number;
  _pendingRequests: { [id: number]: PendingRequest };
  _webSocket: WebSocket | null;
  // Declared without initializer so it does not shadow the prototype-level
  // function assigned below via `Mopidy.prototype._nextRequestId = ...`.
  declare _nextRequestId: () => number;

  constructor(settings?: Mopidy.Options) {
    super();
    this._console = this._getConsole(settings || {});
    this._settings = this._configure(settings || {});
    this._backoffDelay = this._settings.backoffDelayMin;
    this._pendingRequests = {};
    this._webSocket = null;
    this._delegateEvents();
    if (this._settings.autoConnect) {
      this.connect();
    }
  }

  _getConsole(settings: Mopidy.Options): Console {
    if (typeof settings.console !== "undefined") {
      return settings.console;
    }
    const con: Console =
      (typeof console !== "undefined" && console) || ({} as Console);
    con.log = con.log || (() => {});
    con.warn = con.warn || (() => {});
    con.error = con.error || (() => {});
    return con;
  }

  _configure(settings: Mopidy.Options): Required<Mopidy.Options> {
    const newSettings = { ...settings } as Required<Mopidy.Options>;
    const protocol =
      typeof document !== "undefined" && document.location.protocol === "https:"
        ? "wss://"
        : "ws://";
    const currentHost =
      (typeof document !== "undefined" && document.location.host) ||
      "localhost";
    newSettings.webSocketUrl =
      settings.webSocketUrl || `${protocol}${currentHost}/mopidy/ws`;
    if (settings.autoConnect !== false) {
      newSettings.autoConnect = true;
    }
    newSettings.backoffDelayMin = settings.backoffDelayMin || 1000;
    newSettings.backoffDelayMax = settings.backoffDelayMax || 64000;
    return newSettings;
  }

  _delegateEvents(): void {
    // Remove existing event handlers
    this.removeAllListeners("websocket:close");
    this.removeAllListeners("websocket:error");
    this.removeAllListeners("websocket:incomingMessage");
    this.removeAllListeners("websocket:open");
    this.removeAllListeners("state:offline");
    // Register basic set of event handlers
    this.on("websocket:close", this._cleanup);
    this.on("websocket:error", this._handleWebSocketError);
    this.on("websocket:incomingMessage", this._handleMessage);
    this.on("websocket:open", this._resetBackoffDelay);
    this.on("websocket:open", this._getApiSpec);
    this.on("state:offline", this._reconnect);
  }

  off(...args: unknown[]): this {
    if (args.length === 0) {
      this.removeAllListeners();
    } else if (args.length === 1) {
      const arg = args[0];
      if (typeof arg === "string") {
        this.removeAllListeners(arg);
      } else {
        throw Error(
          "Expected no arguments, a string, or a string and a listener."
        );
      }
    } else {
      this.removeListener(
        args[0] as string,
        args[1] as (...listenerArgs: unknown[]) => void
      );
    }
    return this;
  }

  connect(): void {
    if (this._webSocket) {
      if (this._webSocket.readyState === Mopidy.WebSocket.OPEN) {
        return;
      }
      this._webSocket.close();
    }

    this._webSocket =
      this._settings.webSocket ||
      new Mopidy.WebSocket(this._settings.webSocketUrl);

    const ws = this._webSocket;
    ws.onclose = (close) => {
      this.emit("websocket:close", close);
    };
    ws.onerror = (error) => {
      this.emit("websocket:error", error);
    };
    ws.onopen = () => {
      this.emit("websocket:open");
    };
    ws.onmessage = (message) => {
      this.emit("websocket:incomingMessage", message);
    };
  }

  _cleanup(closeEvent: unknown): void {
    Object.keys(this._pendingRequests).forEach((requestId) => {
      const id = Number(requestId);
      const { reject } = this._pendingRequests[id];
      delete this._pendingRequests[id];
      const error = new Mopidy.ConnectionError("WebSocket closed");
      (error as ConnectionError).closeEvent = closeEvent;
      reject(error);
    });
    this.emit("state", "state:offline");
    this.emit("state:offline");
  }

  _reconnect(): void {
    // We asynchronously process the reconnect because we don't want to start
    // emitting "reconnectionPending" events before we've finished handling the
    // "state:offline" event, which would lead to emitting the events to
    // listeners in the wrong order.
    setTimeout(() => {
      this.emit("state", "reconnectionPending", {
        timeToAttempt: this._backoffDelay,
      });
      this.emit("reconnectionPending", {
        timeToAttempt: this._backoffDelay,
      });
      setTimeout(() => {
        this.emit("state", "reconnecting");
        this.emit("reconnecting");
        this.connect();
      }, this._backoffDelay);
      this._backoffDelay *= 2;
      if (this._backoffDelay > this._settings.backoffDelayMax) {
        this._backoffDelay = this._settings.backoffDelayMax;
      }
    }, 1);
  }

  _resetBackoffDelay(): void {
    this._backoffDelay = this._settings.backoffDelayMin;
  }

  close(): void {
    this.off("state:offline", this._reconnect);
    if (this._webSocket) {
      this._webSocket.close();
    }
  }

  _handleWebSocketError(event: Event): void {
    const err = event as Event & { stack?: string };
    this._console.warn("WebSocket error:", err.stack ?? err);
  }

  _send(message: JsonRpcRequest): Promise<unknown> {
    if (!this._webSocket) {
      return Promise.reject(new Mopidy.ConnectionError("WebSocket is closed"));
    }
    switch (this._webSocket.readyState) {
      case Mopidy.WebSocket.CONNECTING:
        return Promise.reject(
          new Mopidy.ConnectionError("WebSocket is still connecting")
        );
      case Mopidy.WebSocket.CLOSING:
        return Promise.reject(
          new Mopidy.ConnectionError("WebSocket is closing")
        );
      case Mopidy.WebSocket.CLOSED:
        return Promise.reject(
          new Mopidy.ConnectionError("WebSocket is closed")
        );
      default:
        return new Promise((resolve, reject) => {
          const jsonRpcMessage = {
            ...message,
            jsonrpc: "2.0",
            id: this._nextRequestId(),
          };
          this._pendingRequests[jsonRpcMessage.id] = { resolve, reject };
          (this._webSocket as WebSocket).send(JSON.stringify(jsonRpcMessage));
          this.emit("websocket:outgoingMessage", jsonRpcMessage);
        });
    }
  }

  _handleMessage(message: MessageEvent | { data: string }): void {
    try {
      const data = JSON.parse(message.data) as JsonRpcResponse &
        Partial<MopidyEventMessage>;
      if (Object.hasOwn(data, "id")) {
        this._handleResponse(data as JsonRpcResponse);
      } else if (Object.hasOwn(data, "event")) {
        this._handleEvent(data as MopidyEventMessage);
      } else {
        this._console.warn(
          `Unknown message type received. Message was: ${message.data}`
        );
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
        this._console.warn(
          `WebSocket message parsing failed. Message was: ${message.data}`
        );
      } else {
        throw error;
      }
    }
  }

  _handleResponse(responseMessage: JsonRpcResponse): void {
    if (!Object.hasOwn(this._pendingRequests, responseMessage.id)) {
      this._console.warn(
        "Unexpected response received. Message was:",
        responseMessage
      );
      return;
    }
    const { resolve, reject } = this._pendingRequests[responseMessage.id];
    delete this._pendingRequests[responseMessage.id];
    if (Object.hasOwn(responseMessage, "result")) {
      resolve(responseMessage.result);
    } else if (Object.hasOwn(responseMessage, "error")) {
      const rpcError = responseMessage.error as NonNullable<
        typeof responseMessage.error
      >;
      const error = new Mopidy.ServerError(rpcError.message);
      error.code = rpcError.code;
      error.data = rpcError.data;
      reject(error);
      this._console.warn("Server returned error:", responseMessage.error);
    } else {
      const error = new Error("Response without 'result' or 'error' received");
      (error as Error & { data?: unknown }).data = {
        response: responseMessage,
      };
      reject(error);
      this._console.warn(
        "Response without 'result' or 'error' received. Message was:",
        responseMessage
      );
    }
  }

  _handleEvent(eventMessage: MopidyEventMessage): void {
    const data = { ...eventMessage } as Partial<MopidyEventMessage>;
    delete data.event;
    const eventName = `event:${snakeToCamel(eventMessage.event)}`;
    this.emit("event", eventName, data);
    this.emit(eventName, data);
  }

  _getApiSpec(): Promise<unknown> {
    return this._send({ method: "core.describe" })
      .then((methods) =>
        this._createApi(
          methods as Record<
            string,
            { description?: string; params?: unknown[] }
          >
        )
      )
      .catch((error) => this._handleWebSocketError(error));
  }

  _createApi(
    methods: Record<string, { description?: string; params?: unknown[] }>
  ): void {
    const caller =
      (method: string) =>
      (...args: unknown[]) => {
        const message: JsonRpcRequest = { method };
        if (args.length === 0) {
          return this._send(message);
        }
        if (args.length > 1) {
          return Promise.reject(
            new Error(
              "Expected zero arguments, a single array, or a single object."
            )
          );
        }
        if (!Array.isArray(args[0]) && args[0] !== Object(args[0])) {
          return Promise.reject(
            new TypeError("Expected an array or an object.")
          );
        }
        [message.params] = args;
        return this._send(message);
      };

    const getPath = (fullName: string): string[] => {
      let path = fullName.split(".");
      if (path.length >= 1 && path[0] === "core") {
        path = path.slice(1);
      }
      return path;
    };

    const createObjects = (objPath: string[]): Record<string, unknown> => {
      let parentObj = this as unknown as Record<string, unknown>;
      objPath.forEach((objName) => {
        const camelObjName = snakeToCamel(objName);
        parentObj[camelObjName] =
          parentObj[camelObjName] || ({} as Record<string, unknown>);
        parentObj = parentObj[camelObjName] as Record<string, unknown>;
      });
      return parentObj;
    };

    const createMethod = (fullMethodName: string): void => {
      const methodPath = getPath(fullMethodName);
      const methodName = snakeToCamel(methodPath.slice(-1)[0]);
      const object = createObjects(methodPath.slice(0, -1));
      const method = caller(fullMethodName) as ((
        ...args: unknown[]
      ) => Promise<unknown>) & {
        description?: string;
        params?: unknown[];
      };
      method.description = methods[fullMethodName].description;
      method.params = methods[fullMethodName].params;
      object[methodName] = method;
    };

    Object.keys(methods).forEach(createMethod);

    this.emit("state", "state:online");
    this.emit("state:online");
  }
}

// Shared, monotonically increasing request ID counter, attached to the
// prototype so that all instances share the same sequence (matches the
// historical behaviour of mopidy.js).
(
  Mopidy.prototype as unknown as { _nextRequestId: () => number }
)._nextRequestId = (() => {
  let lastUsed = -1;
  return () => {
    lastUsed += 1;
    return lastUsed;
  };
})();

// ============================================================================
// Type definitions
// Previously published in src/mopidy.d.ts. Embedded here via declaration
// merging so that the .ts source is the single source of truth.
// ============================================================================

namespace Mopidy {
  export type ValueOf<T> = T[keyof T];
  export type URI = string;

  export interface Options {
    /**
     * URL used when creating new WebSocket objects.
     *
     * In a browser environment, it defaults to
     * ws://${document.location.host}/mopidy/ws. If the current page is served
     * over HTTPS, it defaults to using wss:// instead of ws://.
     *
     * In a non-browser environment, where document.location isn't available, it
     * defaults to ws://localhost/mopidy/ws.
     */
    webSocketUrl?: string;
    /**
     * Whether or not to connect to the WebSocket on instance creation. Defaults
     * to true.
     */
    autoConnect?: boolean;
    /**
     * The minimum number of milliseconds to wait after a connection error before
     * we try to reconnect. For every failed attempt, the backoff delay is doubled
     * until it reaches backoffDelayMax. Defaults to 1000.
     */
    backoffDelayMin?: number;
    /**
     * The maximum number of milliseconds to wait after a connection error before
     * we try to reconnect. Defaults to 64000.
     */
    backoffDelayMax?: number;
    /**
     * If set, this object will be used to log errors from Mopidy.js. This is
     * mostly useful for testing Mopidy.js. Defaults to console.
     */
    console?: Console;
    /**
     * An existing WebSocket object to be used instead of creating a new
     * WebSocket. Defaults to undefined.
     */
    webSocket?: WebSocket;
  }

  export interface StrictEvents extends core.CoreListener {
    /**
     * The events from Mopidy are also emitted under the aggregate event named
     * event.
     */
    event: (args?: unknown) => void;

    /**
     * Client state.
     *
     * You can get notified about when the Mopidy.js client is connected to the
     * server and ready for method calls, when it's offline, and when it's
     * trying to reconnect to the server by looking at these events.
     */
    "state:online": () => void;
    "state:offline": () => void;
    reconnectionPending: ({ timeToAttempt }: { timeToAttempt: number }) => void;
    reconnecting: () => void;
    /**
     * The client state events are also emitted under the aggregate event named
     * state.
     */
    state: (args?: unknown) => void;

    /**
     * WebSocket events.
     */
    "websocket:close": (event: CloseEvent) => void;
    "websocket:error": (event: Event) => void;
    "websocket:incomingMessage": (event: MessageEvent) => void;
    "websocket:open": () => void;
    "websocket:outgoingMessage": (event: unknown) => void;
  }

  // https://docs.mopidy.com/en/latest/api/models/
  export namespace models {
    export type ModelType =
      | "album"
      | "artist"
      | "directory"
      | "playlist"
      | "track";

    export interface Ref<T extends ModelType> {
      readonly name: string;
      readonly type: T;
      readonly uri: URI;
    }

    /**
     * A tracklist track. Wraps a regular track and its tracklist ID.
     */
    export interface TlTrack {
      readonly tlid: number;
      readonly track: Track;
    }

    export interface Track {
      readonly uri: URI;
      readonly name: string;
      readonly artists: Artist[];
      readonly album: Album;
      readonly composers: Artist[];
      readonly performers: Artist[];
      readonly genre: string;
      readonly track_no: number;
      readonly disc_no: number;
      readonly date: string;
      readonly length: number;
      readonly bitrate: string;
      readonly comment: string;
      readonly musicbrainz_id: string;
      readonly last_modified: number;
    }

    export interface SearchResult {
      readonly uri: URI;
      readonly tracks: Track[];
      readonly artists: Artist[];
      readonly albums: Album[];
    }

    export interface Artist {
      readonly uri: URI;
      readonly name: string;
      readonly sortname: string;
      readonly musicbrainz_id: string;
    }

    export interface Album {
      readonly uri: URI;
      readonly name: string;
      readonly artists: Artist[];
      readonly num_tracks: number;
      readonly num_discs: number;
      readonly date: string;
      readonly musicbrainz_id: string;
    }

    export interface Image {
      readonly uri: URI;
      readonly width: number;
      readonly height: number;
    }

    export interface Playlist {
      readonly uri: URI;
      readonly name: string;
      readonly tracks: Track[];
      readonly last_modified: number;
      readonly length: number;
    }
  }

  /**
   * The core API is the interface that is used by frontends like mopidy.http
   * and Mopidy-MPD. The core layer is in between the frontends and the
   * backends.
   */
  export namespace core {
    export type PlaybackState = "playing" | "paused" | "stopped";
    export type QueryField =
      | "uri"
      | "track_name"
      | "album"
      | "artist"
      | "albumartist"
      | "composer"
      | "performer"
      | "track_no"
      | "genre"
      | "date"
      | "comment"
      | "any";
    export type Query = { [key in QueryField]?: string[] };

    /**
     * Core events emitted by the Mopidy server, prefixed with `event:`.
     */
    export interface CoreListener {
      "event:muteChanged": ({ mute }: { mute: boolean }) => void;
      "event:optionsChanged": () => void;
      "event:playbackStateChanged": ({
        old_state,
        new_state,
      }: {
        old_state: PlaybackState;
        new_state: PlaybackState;
      }) => void;
      "event:playlistChanged": ({
        playlist,
      }: {
        playlist: models.Playlist;
      }) => void;
      "event:playlistDeleted": ({ uri }: { uri: URI }) => void;
      "event:playlistsLoaded": () => void;
      "event:seeked": ({ time_position }: { time_position: number }) => void;
      "event:streamTitleChanged": ({ title }: { title: string }) => void;
      "event:trackPlaybackEnded": ({
        tl_track,
        time_position,
      }: {
        tl_track: models.TlTrack;
        time_position: number;
      }) => void;
      "event:trackPlaybackPaused": ({
        tl_track,
        time_position,
      }: {
        tl_track: models.TlTrack;
        time_position: number;
      }) => void;
      "event:trackPlaybackResumed": ({
        tl_track,
        time_position,
      }: {
        tl_track: models.TlTrack;
        time_position: number;
      }) => void;
      "event:trackPlaybackStarted": ({
        tl_track,
      }: {
        tl_track: models.TlTrack;
      }) => void;
      /**
       * Called whenever playback of the current track is stopped.
       */
      "event:trackPlaybackStopped": ({
        tl_track,
        time_position,
      }: {
        tl_track: models.TlTrack;
        time_position: number;
      }) => void;
      "event:tracklistChanged": () => void;
      "event:volumeChanged": ({ volume }: { volume: number }) => void;
    }

    // https://docs.mopidy.com/en/latest/api/core/#tracklist-controller
    export interface TracklistController {
      add({
        tracks,
        at_position,
        uris,
      }: {
        tracks?: models.Track[];
        at_position?: number;
        uris?: string[];
      }): Promise<models.TlTrack[]>;
      remove({
        criteria,
      }: {
        criteria: { [key: string]: string[] };
      }): Promise<models.TlTrack[]>;
      clear(): Promise<void>;
      move({
        start,
        end,
        to_position,
      }: {
        start: number;
        end: number;
        to_position: number;
      }): Promise<void>;
      shuffle({
        start,
        end,
      }: {
        start?: number;
        end?: number;
      }): Promise<void>;
      getTlTracks(): Promise<models.TlTrack[]>;
      index({
        tl_track,
        tlid,
      }: {
        tl_track?: models.TlTrack;
        tlid?: number;
      }): Promise<number | null>;
      getVersion(): Promise<number>;
      getLength(): Promise<number>;
      getTracks(): Promise<models.Track[]>;
      slice({
        start,
        end,
      }: {
        start: number;
        end: number;
      }): Promise<models.TlTrack[]>;
      filter({
        criteria,
      }: {
        criteria: { [key: string]: string[] };
      }): Promise<models.TlTrack[]>;
      getEotTlid(): Promise<number | null>;
      getNextTlid(): Promise<number | null>;
      getPreviousTlid(): Promise<number | null>;
      eotTrack({
        tl_track,
      }: {
        tl_track?: models.TlTrack;
      }): Promise<models.TlTrack | null>;
      /** @deprecated Use `getNextTlid()` instead. */
      nextTrack({
        tl_track,
      }: {
        tl_track: models.TlTrack;
      }): Promise<models.TlTrack | null>;
      /** @deprecated Use `getPreviousTlid()` instead. */
      previousTrack({
        tl_track,
      }: {
        tl_track: models.TlTrack;
      }): Promise<models.TlTrack | null>;
      getConsume(): Promise<boolean>;
      setConsume({ value }: { value: boolean }): Promise<void>;
      getRandom(): Promise<boolean>;
      setRandom({ value }: { value: boolean }): Promise<void>;
      getRepeat(): Promise<boolean>;
      setRepeat({ value }: { value: boolean }): Promise<void>;
      getSingle(): Promise<boolean>;
      setSingle({ value }: { value: boolean }): Promise<void>;
    }

    // https://docs.mopidy.com/en/latest/api/core/#playback-controller
    export interface PlaybackController {
      play({
        track,
        tlid,
      }: {
        track?: models.TlTrack;
        tlid?: number;
      }): Promise<void>;
      next(): Promise<void>;
      previous(): Promise<void>;
      stop(): Promise<void>;
      pause(): Promise<void>;
      resume(): Promise<void>;
      seek({ time_position }: { time_position: number }): Promise<boolean>;
      getCurrentTlTrack(): Promise<models.TlTrack | null>;
      getCurrentTrack(): Promise<models.Track | null>;
      getStreamTitle(): Promise<string | null>;
      getTimePosition(): Promise<number | null>;
      getState(): Promise<PlaybackState>;
      setState({ new_state }: { new_state: PlaybackState }): Promise<void>;
    }

    // https://docs.mopidy.com/en/latest/api/core/#library-controller
    export interface LibraryController {
      browse({
        uri,
      }: { uri: URI | null }): Promise<models.Ref<models.ModelType>[]>;
      search({
        query,
        uris,
        exact,
      }: {
        query: Query;
        uris?: string[];
        exact?: boolean;
      }): Promise<models.SearchResult[]>;
      lookup({
        uris,
      }: {
        uris: string[];
      }): Promise<{ [index: string]: models.Track[] }>;
      refresh({ uri }: { uri?: string }): Promise<void>;
      getImages({
        uris,
      }: {
        uris: string[];
      }): Promise<{ [index: string]: models.Image[] }>;
    }

    // https://docs.mopidy.com/en/latest/api/core/#playlists-controller
    export interface PlaylistsController {
      getUriSchemes(): Promise<string[]>;
      asList(): Promise<models.Ref<models.ModelType>[]>;
      getItems({
        uri,
      }: {
        uri: string;
      }): Promise<models.Ref<models.ModelType>[] | null>;
      lookup({ uri }: { uri: URI }): Promise<models.Playlist | null>;
      refresh({ uri_scheme }: { uri_scheme?: string }): Promise<void>;
      create({
        name,
        uri_scheme,
      }: {
        name: string;
        uri_scheme?: string;
      }): Promise<models.Playlist | null>;
      save({
        playlist,
      }: {
        playlist: models.Playlist;
      }): Promise<models.Playlist | null>;
      delete({ uri }: { uri: URI }): Promise<boolean>;
    }

    // https://docs.mopidy.com/en/latest/api/core/#mixer-controller
    export interface MixerController {
      getMute(): Promise<boolean | null>;
      setMute({ mute }: { mute: boolean }): Promise<boolean>;
      getVolume(): Promise<number | null>;
      setVolume({ volume }: { volume: number }): Promise<boolean>;
    }

    export interface HistoryController {
      getHistory(): Promise<{
        [index: string]: models.Ref<models.ModelType>[];
      }>;
      getLength(): Promise<number>;
    }
  }
}

interface Mopidy {
  /**
   * Manages everything related to the list of tracks we will play.
   * Undefined before Mopidy connects.
   */
  tracklist?: Mopidy.core.TracklistController;
  /**
   * Manages playback state and the current playing track.
   * Undefined before Mopidy connects.
   */
  playback?: Mopidy.core.PlaybackController;
  /**
   * Manages the music library, e.g. searching and browsing for music.
   * Undefined before Mopidy connects.
   */
  library?: Mopidy.core.LibraryController;
  /** Manages stored playlists. Undefined before Mopidy connects. */
  playlists?: Mopidy.core.PlaylistsController;
  /** Manages volume and muting. Undefined before Mopidy connects. */
  mixer?: Mopidy.core.MixerController;
  /** Keeps record of what tracks have been played. */
  history?: Mopidy.core.HistoryController;

  /** Get list of URI schemes we can handle. */
  getUriSchemes?(): Promise<string[]>;
  /** Get version of the Mopidy core API. */
  getVersion?(): Promise<string>;

  on<K extends keyof Mopidy.StrictEvents>(
    name: K,
    listener: Mopidy.StrictEvents[K]
  ): this;
  on(name: string | symbol, listener: (...args: unknown[]) => void): this;
}

export default Mopidy;
export { ConnectionError, ServerError };
