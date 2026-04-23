import { EventEmitter } from "events";

function snakeToCamel(name: string): string {
  return name.replace(/(_[a-z])/g, (match) =>
    match.toUpperCase().replace("_", "")
  );
}

export interface Options {
  webSocketUrl?: string;
  autoConnect?: boolean;
  backoffDelayMin?: number;
  backoffDelayMax?: number;
  console?: Console;
  webSocket?: WebSocket;
}

interface Settings {
  webSocketUrl: string;
  autoConnect: boolean;
  backoffDelayMin: number;
  backoffDelayMax: number;
  console?: Console;
  webSocket?: WebSocket;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

interface JsonRpcMessage {
  method: string;
  params?: unknown[] | Record<string, unknown>;
  jsonrpc?: string;
  id?: number;
}

type MopidyConsole = {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

class Mopidy extends EventEmitter {
  static WebSocket: typeof globalThis.WebSocket;
  static ConnectionError: typeof ConnectionError;
  static ServerError: typeof ServerError;

  _console: MopidyConsole;
  _settings: Settings;
  _backoffDelay: number;
  _pendingRequests: Record<number, PendingRequest>;
  _webSocket: WebSocket | null;

  constructor(settings?: Options) {
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

  _getConsole(settings: Options): MopidyConsole {
    if (typeof settings.console !== "undefined") {
      return settings.console as unknown as MopidyConsole;
    }
    const con =
      (typeof console !== "undefined" &&
        (console as unknown as Partial<MopidyConsole>)) ||
      ({} as Partial<MopidyConsole>);
    con.log = con.log || (() => {});
    con.warn = con.warn || (() => {});
    con.error = con.error || (() => {});
    return con as MopidyConsole;
  }

  _configure(settings: Options): Settings {
    const newSettings = { ...settings } as Settings;
    const protocol =
      typeof document !== "undefined" &&
      document.location.protocol === "https:"
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
        args[1] as (...a: unknown[]) => void
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
      (this._settings.webSocket as WebSocket | undefined) ||
      new Mopidy.WebSocket(this._settings.webSocketUrl);

    this._webSocket.onclose = (close: CloseEvent) => {
      this.emit("websocket:close", close);
    };
    this._webSocket.onerror = (error: Event) => {
      this.emit("websocket:error", error);
    };
    this._webSocket.onopen = () => {
      this.emit("websocket:open");
    };
    this._webSocket.onmessage = (message: MessageEvent) => {
      this.emit("websocket:incomingMessage", message);
    };
  }

  _cleanup(closeEvent: CloseEvent): void {
    Object.keys(this._pendingRequests).forEach((requestId) => {
      const id = Number(requestId);
      const { reject } = this._pendingRequests[id];
      delete this._pendingRequests[id];
      const error = new Mopidy.ConnectionError("WebSocket closed");
      error.closeEvent = closeEvent;
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

  _handleWebSocketError(error: Event & { stack?: string }): void {
    this._console.warn("WebSocket error:", error.stack || error);
  }

  _send(message: JsonRpcMessage): Promise<unknown> {
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
          this._webSocket!.send(JSON.stringify(jsonRpcMessage));
          this.emit("websocket:outgoingMessage", jsonRpcMessage);
        });
    }
  }

  _handleMessage(message: MessageEvent): void {
    try {
      const data = JSON.parse(message.data as string) as Record<
        string,
        unknown
      >;
      if (Object.hasOwn(data, "id")) {
        this._handleResponse(data);
      } else if (Object.hasOwn(data, "event")) {
        this._handleEvent(data);
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

  _handleResponse(responseMessage: Record<string, unknown>): void {
    const id = responseMessage.id as number;
    if (!Object.hasOwn(this._pendingRequests, id)) {
      this._console.warn(
        "Unexpected response received. Message was:",
        responseMessage
      );
      return;
    }
    const { resolve, reject } = this._pendingRequests[id];
    delete this._pendingRequests[id];
    if (Object.hasOwn(responseMessage, "result")) {
      resolve(responseMessage.result);
    } else if (Object.hasOwn(responseMessage, "error")) {
      const errData = responseMessage.error as {
        message: string;
        code: number;
        data?: unknown;
      };
      const error = new Mopidy.ServerError(errData.message);
      error.code = errData.code;
      error.data = errData.data;
      reject(error);
      this._console.warn("Server returned error:", responseMessage.error);
    } else {
      const error = new Error(
        "Response without 'result' or 'error' received"
      ) as Error & { data?: unknown };
      error.data = { response: responseMessage };
      reject(error);
      this._console.warn(
        "Response without 'result' or 'error' received. Message was:",
        responseMessage
      );
    }
  }

  _handleEvent(eventMessage: Record<string, unknown>): void {
    const data = { ...eventMessage };
    delete data.event;
    const eventName = `event:${snakeToCamel(eventMessage.event as string)}`;
    this.emit("event", eventName, data);
    this.emit(eventName, data);
  }

  _getApiSpec(): Promise<void> {
    return this._send({ method: "core.describe" })
      .then((methods) =>
        this._createApi(
          methods as Record<string, { description: string; params: unknown[] }>
        )
      )
      .catch(this._handleWebSocketError.bind(this));
  }

  _createApi(
    methods: Record<string, { description: string; params: unknown[] }>
  ): void {
    const caller =
      (method: string) =>
      (...args: unknown[]): Promise<unknown> => {
        const message: JsonRpcMessage = { method };
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
        message.params = args[0] as unknown[] | Record<string, unknown>;
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
      let parentObj: Record<string, unknown> =
        this as unknown as Record<string, unknown>;
      objPath.forEach((objName) => {
        const camelObjName = snakeToCamel(objName);
        parentObj[camelObjName] =
          (parentObj[camelObjName] as Record<string, unknown>) || {};
        parentObj = parentObj[camelObjName] as Record<string, unknown>;
      });
      return parentObj;
    };

    const createMethod = (fullMethodName: string): void => {
      const methodPath = getPath(fullMethodName);
      const methodName = snakeToCamel(methodPath.slice(-1)[0]);
      const object = createObjects(methodPath.slice(0, -1));
      const fn = caller(fullMethodName) as ((...args: unknown[]) => Promise<unknown>) & {
        description?: string;
        params?: unknown[];
      };
      fn.description = methods[fullMethodName].description;
      fn.params = methods[fullMethodName].params;
      object[methodName] = fn;
    };

    Object.keys(methods).forEach(createMethod);

    this.emit("state", "state:online");
    this.emit("state:online");
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _nextRequestId(): number {
    // This method body is never called. The real implementation is installed
    // as a prototype-level closure after the class definition (see below),
    // so that tests can spy on and mock it per-instance via jest.spyOn().
    return 0;
  }
}

export class ConnectionError extends Error {
  closeEvent?: CloseEvent;
  constructor(message: string) {
    super(message);
    this.name = "ConnectionError";
  }
}
Mopidy.ConnectionError = ConnectionError;

export class ServerError extends Error {
  code?: number;
  data?: unknown;
  constructor(message: string) {
    super(message);
    this.name = "ServerError";
  }
}
Mopidy.ServerError = ServerError;

// Use the global WebSocket (available in Bun, browsers, and Node 22+)
Mopidy.WebSocket = globalThis.WebSocket;

// Keep the incrementing request ID as a prototype-level closure
// so tests can spy on and mock _nextRequestId per-instance
Mopidy.prototype._nextRequestId = (() => {
  let lastUsed = -1;
  return function (this: Mopidy): number {
    lastUsed += 1;
    return lastUsed;
  };
})();

export default Mopidy;
