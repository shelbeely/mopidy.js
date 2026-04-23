import {
  beforeEach,
  describe,
  expect,
  jest,
  mock,
  spyOn,
  test,
} from "bun:test";

import Mopidy from "../src/mopidy";

const warn = spyOn(globalThis.console, "warn").mockImplementation(() => {});

// Custom matcher to replace jest-extended's `toHaveBeenCalledAfter`.
expect.extend({
  toHaveBeenCalledAfter(received: any, other: any) {
    const receivedOrder: number[] = received?.mock?.invocationCallOrder ?? [];
    const otherOrder: number[] = other?.mock?.invocationCallOrder ?? [];
    if (receivedOrder.length === 0) {
      return {
        pass: false,
        message: () =>
          "expected mock to have been called after another, but it was never called",
      };
    }
    if (otherOrder.length === 0) {
      return {
        pass: false,
        message: () =>
          "expected mock to have been called after another, but the other mock was never called",
      };
    }
    const pass = receivedOrder[0] > otherOrder[otherOrder.length - 1];
    return {
      pass,
      message: () =>
        `expected mock to have been called after the other mock\n` +
        `  received first call order: ${receivedOrder[0]}\n` +
        `  other last call order:     ${otherOrder[otherOrder.length - 1]}`,
    };
  },
});

jest.useFakeTimers();

// Shared per-test state. Set up in `beforeEach` and read inside test bodies.
const ctx: {
  mopidy: any;
  openWebSocket: any;
  WebSocketMock: any;
  sendStub?: any;
} = {
  mopidy: undefined,
  openWebSocket: undefined,
  WebSocketMock: undefined,
};

beforeEach(() => {
  // Discard any timers left scheduled by previous tests so each test starts
  // from a clean slate when fake timers are enabled.
  jest.clearAllTimers();

  // Create a generic WebSocket mock
  const WebSocketMock: any = mock(() => ({
    close: mock(function close(this: any) {
      this.onclose({});
    }),
    send: mock(() => {}),
    readyState: WebSocketMock.CLOSED,
  }));
  WebSocketMock.CONNECTING = 0;
  WebSocketMock.OPEN = 1;
  WebSocketMock.CLOSING = 2;
  WebSocketMock.CLOSED = 3;

  // Use the WebSocketMock to create all new WebSockets
  (Mopidy as any).WebSocket = WebSocketMock;
  ctx.WebSocketMock = WebSocketMock;

  // Create Mopidy instance good enough for most tests
  ctx.openWebSocket = new WebSocketMock();
  ctx.openWebSocket.readyState = WebSocketMock.OPEN;
  WebSocketMock.mockClear();
  ctx.mopidy = new Mopidy({
    webSocket: ctx.openWebSocket,
  });

  // Clear mocks with state that can cross between tests
  warn.mockClear();
});

describe("constructor", () => {
  test("connects when autoConnect is true", () => {
    new Mopidy({
      autoConnect: true,
    });

    const currentHost =
      (typeof document !== "undefined" && document.location.host) ||
      "localhost";

    expect(ctx.WebSocketMock).toHaveBeenCalledWith(
      `ws://${currentHost}/mopidy/ws`
    );
  });

  test("does not connect when autoConnect is false", () => {
    new Mopidy({
      autoConnect: false,
    });

    expect(ctx.WebSocketMock).not.toHaveBeenCalled();
  });

  test("does not connect when passed a WebSocket", () => {
    new Mopidy({
      webSocket: {} as any,
    });

    expect(ctx.WebSocketMock).not.toHaveBeenCalled();
  });
});

describe(".off", () => {
  test("with no args works", () => {
    const removeAllStub = spyOn(ctx.mopidy, "removeAllListeners");

    ctx.mopidy.off();

    expect(removeAllStub).toHaveBeenCalledWith();
  });

  test("with an event name works", () => {
    const removeAllStub = spyOn(ctx.mopidy, "removeAllListeners");

    ctx.mopidy.off("some-event");

    expect(removeAllStub).toHaveBeenCalledWith("some-event");
  });

  test("with a listener fails", () => {
    const listener = () => {};
    const removeAllStub = spyOn(ctx.mopidy, "removeAllListeners");

    try {
      ctx.mopidy.off(listener);
    } catch (error: any) {
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe(
        "Expected no arguments, a string, or a string and a listener."
      );
    }

    expect(removeAllStub).not.toHaveBeenCalled();
  });

  test("with an event name and a listener works", () => {
    const listener = () => {};
    const removeStub = spyOn(ctx.mopidy, "removeListener");

    ctx.mopidy.off("some-event", listener);

    expect(removeStub).toHaveBeenCalledWith("some-event", listener);
  });
});

describe(".connect", () => {
  test("connects when autoConnect is false", () => {
    const mopidy = new Mopidy({
      autoConnect: false,
    });
    expect(ctx.WebSocketMock).not.toHaveBeenCalled();

    mopidy.connect();

    const currentHost =
      (typeof document !== "undefined" && document.location.host) ||
      "localhost";

    expect(ctx.WebSocketMock).toHaveBeenCalledWith(
      `ws://${currentHost}/mopidy/ws`
    );
  });

  test("does nothing when the WebSocket is open", () => {
    expect(ctx.mopidy._webSocket).toBe(ctx.openWebSocket);
    expect(ctx.openWebSocket.readyState).toBe(ctx.WebSocketMock.OPEN);

    ctx.mopidy.connect();

    expect(ctx.openWebSocket.close).not.toHaveBeenCalled();
    expect(ctx.WebSocketMock).not.toHaveBeenCalled();
  });
});

describe("WebSocket events", () => {
  test("emits 'websocket:close' when connection is closed", () => {
    const spy = mock(() => {});
    ctx.mopidy.on("websocket:close", spy);

    const closeEvent = {};
    ctx.mopidy._webSocket.onclose(closeEvent);

    expect(spy).toHaveBeenCalledWith(closeEvent);
  });

  test("emits 'websocket:error' when errors occurs", () => {
    const spy = mock(() => {});
    ctx.mopidy.on("websocket:error", spy);

    const errorEvent = {};
    ctx.mopidy._webSocket.onerror(errorEvent);

    expect(spy).toHaveBeenCalledWith(errorEvent);
  });

  test("emits 'websocket:incomingMessage' when a message arrives", () => {
    const spy = mock(() => {});
    ctx.mopidy.on("websocket:incomingMessage", spy);

    const messageEvent = { data: "this is a message" };
    ctx.mopidy._webSocket.onmessage(messageEvent);

    expect(spy).toHaveBeenCalledWith(messageEvent);
  });

  test("emits 'websocket:open' when connection is opened", () => {
    const spy = mock(() => {});
    ctx.mopidy.on("websocket:open", spy);

    ctx.mopidy._webSocket.onopen();

    expect(spy).toHaveBeenCalledWith();
  });
});

describe("._cleanup", () => {
  beforeEach(() => {
    ctx.mopidy.removeAllListeners("state:offline");
  });

  test("is called on 'websocket:close' event", () => {
    const closeEvent = {};
    const cleanup = spyOn(ctx.mopidy, "_cleanup");
    ctx.mopidy._delegateEvents();

    ctx.mopidy.emit("websocket:close", closeEvent);

    expect(cleanup).toHaveBeenCalledWith(closeEvent);
  });

  test("rejects all pending requests", async () => {
    const closeEvent = {};
    expect(Object.keys(ctx.mopidy._pendingRequests).length).toBe(0);

    const promise1 = ctx.mopidy._send({ method: "foo" });
    const promise2 = ctx.mopidy._send({ method: "bar" });
    expect(Object.keys(ctx.mopidy._pendingRequests).length).toBe(2);

    ctx.mopidy._cleanup(closeEvent);

    expect(Object.keys(ctx.mopidy._pendingRequests).length).toBe(0);
    const errors = await Promise.all([
      promise1.catch((error: any) => error),
      promise2.catch((error: any) => error),
    ]);
    errors.forEach((error: any) => {
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(Mopidy.ConnectionError);
      expect(error.message).toBe("WebSocket closed");
      expect(error.closeEvent).toBe(closeEvent);
    });
  });

  test("emits 'state' event when done", () => {
    const spy = mock(() => {});
    ctx.mopidy.on("state", spy);

    ctx.mopidy._cleanup({});

    expect(spy).toHaveBeenCalledWith("state:offline");
  });

  test("emits 'state:offline' event when done", () => {
    const spy = mock(() => {});
    ctx.mopidy.on("state:offline", spy);

    ctx.mopidy._cleanup({});

    expect(spy).toHaveBeenCalledWith();
  });
});

describe("._reconnect", () => {
  test("is called when the state changes to offline", () => {
    const spy = spyOn(ctx.mopidy, "_reconnect");
    ctx.mopidy._delegateEvents();

    ctx.mopidy.emit("state:offline");
    jest.runOnlyPendingTimers();

    expect(spy).toHaveBeenCalledWith();
  });

  test("tries to connect after an increasing backoff delay", () => {
    const connectStub = spyOn(ctx.mopidy, "connect").mockImplementation(
      () => {}
    );
    const stateSpy = mock(() => {});
    ctx.mopidy.on("state", stateSpy);
    const pendingSpy = mock(() => {});
    ctx.mopidy.on("reconnectionPending", pendingSpy);
    const reconnectingSpy = mock(() => {});
    ctx.mopidy.on("reconnecting", reconnectingSpy);

    expect(connectStub).toHaveBeenCalledTimes(0);

    ctx.mopidy._reconnect();
    jest.runOnlyPendingTimers();
    expect(stateSpy).toHaveBeenCalledWith("reconnectionPending", {
      timeToAttempt: 1000,
    });
    expect(pendingSpy).toHaveBeenCalledWith({ timeToAttempt: 1000 });
    jest.advanceTimersByTime(0);
    expect(connectStub).toHaveBeenCalledTimes(0);
    jest.advanceTimersByTime(1000);
    expect(connectStub).toHaveBeenCalledTimes(1);
    expect(stateSpy).toHaveBeenCalledWith("reconnecting");
    expect(reconnectingSpy).toHaveBeenCalledWith();

    stateSpy.mockClear();
    pendingSpy.mockClear();
    reconnectingSpy.mockClear();
    ctx.mopidy._reconnect();
    jest.runOnlyPendingTimers();
    expect(stateSpy).toHaveBeenCalledWith("reconnectionPending", {
      timeToAttempt: 2000,
    });
    expect(pendingSpy).toHaveBeenCalledWith({ timeToAttempt: 2000 });
    expect(connectStub).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(0);
    expect(connectStub).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1000);
    expect(connectStub).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1000);
    expect(connectStub).toHaveBeenCalledTimes(2);
    expect(stateSpy).toHaveBeenCalledWith("reconnecting");
    expect(reconnectingSpy).toHaveBeenCalledWith();

    stateSpy.mockClear();
    pendingSpy.mockClear();
    reconnectingSpy.mockClear();
    ctx.mopidy._reconnect();
    jest.runOnlyPendingTimers();
    expect(stateSpy).toHaveBeenCalledWith("reconnectionPending", {
      timeToAttempt: 4000,
    });
    expect(pendingSpy).toHaveBeenCalledWith({ timeToAttempt: 4000 });
    expect(connectStub).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(0);
    expect(connectStub).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(2000);
    expect(connectStub).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(2000);
    expect(connectStub).toHaveBeenCalledTimes(3);
    expect(stateSpy).toHaveBeenCalledWith("reconnecting");
    expect(reconnectingSpy).toHaveBeenCalledWith();
  });

  test("tries to connect at least about once per minute", () => {
    const connectStub = spyOn(ctx.mopidy, "connect").mockImplementation(
      () => {}
    );
    const stateSpy = mock(() => {});
    ctx.mopidy.on("state", stateSpy);
    const pendingSpy = mock(() => {});
    ctx.mopidy.on("reconnectionPending", pendingSpy);
    ctx.mopidy._backoffDelay = ctx.mopidy._settings.backoffDelayMax;

    expect(connectStub).toHaveBeenCalledTimes(0);

    ctx.mopidy._reconnect();
    jest.runOnlyPendingTimers();
    expect(stateSpy).toHaveBeenCalledWith("reconnectionPending", {
      timeToAttempt: 64000,
    });
    expect(pendingSpy).toHaveBeenCalledWith({ timeToAttempt: 64000 });
    jest.advanceTimersByTime(0);
    expect(connectStub).toHaveBeenCalledTimes(0);
    jest.advanceTimersByTime(64000);
    expect(connectStub).toHaveBeenCalledTimes(1);

    stateSpy.mockClear();
    pendingSpy.mockClear();
    ctx.mopidy._reconnect();
    jest.runOnlyPendingTimers();
    expect(stateSpy).toHaveBeenCalledWith("reconnectionPending", {
      timeToAttempt: 64000,
    });
    expect(pendingSpy).toHaveBeenCalledWith({ timeToAttempt: 64000 });
    expect(connectStub).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(0);
    expect(connectStub).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(64000);
    expect(connectStub).toHaveBeenCalledTimes(2);
  });

  test("emits reconnectionPending after state:offline event", () => {
    const offlineSpy = mock(() => {});
    ctx.mopidy.on("state:offline", offlineSpy);
    const reconnectionSpy = mock(() => {});
    ctx.mopidy.on("reconnectionPending", reconnectionSpy);

    ctx.mopidy.emit("websocket:close");

    expect(offlineSpy).toHaveBeenCalledWith();

    // Before we check the reconnection spy we have to run pending timers
    // again, because the reconnection happens in an async listener of the
    // state:offline event.
    jest.runOnlyPendingTimers();

    expect(reconnectionSpy).toHaveBeenCalledWith({ timeToAttempt: 1000 });
    (expect(reconnectionSpy) as any).toHaveBeenCalledAfter(offlineSpy);
  });
});

describe("._resetBackoffDelay", () => {
  test("is called on 'websocket:open' event", () => {
    const spy = spyOn(ctx.mopidy, "_resetBackoffDelay");
    ctx.mopidy._delegateEvents();

    ctx.mopidy.emit("websocket:open");

    expect(spy).toHaveBeenCalled();
  });

  test("resets the backoff delay to the minimum value", () => {
    ctx.mopidy._backoffDelay = ctx.mopidy._backoffDelayMax;

    ctx.mopidy._resetBackoffDelay();

    expect(ctx.mopidy._backoffDelay).toBe(ctx.mopidy._settings.backoffDelayMin);
  });
});

describe(".close", () => {
  test("unregisters reconnection hooks", () => {
    const offSpy = spyOn(ctx.mopidy, "off");
    const reconnectingSpy = mock(() => {});
    ctx.mopidy.on("reconnecting", reconnectingSpy);
    const reconnectionPendingSpy = mock(() => {});
    ctx.mopidy.on("reconnectionPending", reconnectionPendingSpy);

    ctx.mopidy.close();

    expect(offSpy).toHaveBeenCalledWith("state:offline", ctx.mopidy._reconnect);

    jest.runOnlyPendingTimers(); // Handle the "state:offline" event

    expect(reconnectingSpy).not.toHaveBeenCalled();
    expect(reconnectionPendingSpy).not.toHaveBeenCalled();
  });

  test("closes the WebSocket", () => {
    ctx.mopidy.close();

    expect(ctx.mopidy._webSocket.close).toHaveBeenCalledWith();
  });

  test("close without an open WebSocket does not fail", () => {
    const mopidy = new Mopidy({ autoConnect: false });

    mopidy.close(); // No error thrown
  });
});

describe("._handleWebSocketError", () => {
  test("is called on 'websocket:error' event", () => {
    const error = {};
    const spy = spyOn(ctx.mopidy, "_handleWebSocketError");
    ctx.mopidy._delegateEvents();

    ctx.mopidy.emit("websocket:error", error);

    expect(spy).toHaveBeenCalledWith(error);
  });

  test("without stack logs the error to the console", () => {
    const error = {};

    ctx.mopidy._handleWebSocketError(error);

    expect(warn).toHaveBeenCalledWith("WebSocket error:", error);
  });

  test("with stack logs the error to the console", () => {
    const error = { stack: "foo" };

    ctx.mopidy._handleWebSocketError(error);

    expect(warn).toHaveBeenCalledWith("WebSocket error:", error.stack);
  });
});

describe("._send", () => {
  test("adds JSON-RPC fields to the message", () => {
    spyOn(ctx.mopidy, "_nextRequestId").mockImplementation(() => 1);
    const spy = spyOn(JSON, "stringify");

    ctx.mopidy._send({ method: "foo" });

    expect(spy).toHaveBeenCalledWith({
      jsonrpc: "2.0",
      id: 1,
      method: "foo",
    });
    spy.mockRestore();
  });

  test("adds a resolver to the pending requests queue", () => {
    spyOn(ctx.mopidy, "_nextRequestId").mockImplementation(() => 1);
    expect(Object.keys(ctx.mopidy._pendingRequests).length).toBe(0);

    ctx.mopidy._send({ method: "foo" });

    expect(Object.keys(ctx.mopidy._pendingRequests).length).toBe(1);
    expect(ctx.mopidy._pendingRequests[1].resolve).toBeDefined();
  });

  test("sends message on the WebSocket", () => {
    expect(ctx.mopidy._webSocket.send).toHaveBeenCalledTimes(0);

    ctx.mopidy._send({ method: "foo" });

    expect(ctx.mopidy._webSocket.send).toHaveBeenCalledTimes(1);
  });

  test("emits a 'websocket:outgoingMessage' event", () => {
    const spy = mock(() => {});
    ctx.mopidy.on("websocket:outgoingMessage", spy);
    spyOn(ctx.mopidy, "_nextRequestId").mockImplementation(() => 1);

    ctx.mopidy._send({ method: "foo" });

    expect(spy).toHaveBeenCalledWith({
      jsonrpc: "2.0",
      id: 1,
      method: "foo",
    });
  });

  test("immediately rejects request if CONNECTING", async () => {
    ctx.mopidy._webSocket.readyState = ctx.WebSocketMock.CONNECTING;

    const promise = ctx.mopidy._send({ method: "foo" });

    expect.hasAssertions();
    await promise.catch((error: any) => {
      expect(ctx.mopidy._webSocket.send).toHaveBeenCalledTimes(0);
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(Mopidy.ConnectionError);
      expect(error.message).toBe("WebSocket is still connecting");
    });
  });

  test("immediately rejects request if CLOSING", async () => {
    ctx.mopidy._webSocket.readyState = ctx.WebSocketMock.CLOSING;

    const promise = ctx.mopidy._send({ method: "foo" });

    expect.hasAssertions();
    await promise.catch((error: any) => {
      expect(ctx.mopidy._webSocket.send).toHaveBeenCalledTimes(0);
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(Mopidy.ConnectionError);
      expect(error.message).toBe("WebSocket is closing");
    });
  });

  test("immediately rejects request if CLOSED", async () => {
    ctx.mopidy._webSocket.readyState = ctx.WebSocketMock.CLOSED;

    const promise = ctx.mopidy._send({ method: "foo" });

    expect.hasAssertions();
    await promise.catch((error: any) => {
      expect(ctx.mopidy._webSocket.send).toHaveBeenCalledTimes(0);
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(Mopidy.ConnectionError);
      expect(error.message).toBe("WebSocket is closed");
    });
  });
});

describe("._nextRequestId", () => {
  test("returns an ever increasing ID", () => {
    const base = ctx.mopidy._nextRequestId();
    expect(ctx.mopidy._nextRequestId()).toBe(base + 1);
    expect(ctx.mopidy._nextRequestId()).toBe(base + 2);
    expect(ctx.mopidy._nextRequestId()).toBe(base + 3);
  });
});

describe("._handleMessage", () => {
  test("is called on 'websocket:incomingMessage' event", () => {
    const messageEvent = {};
    const stub = spyOn(ctx.mopidy, "_handleMessage").mockImplementation(
      () => {}
    );
    ctx.mopidy._delegateEvents();

    ctx.mopidy.emit("websocket:incomingMessage", messageEvent);

    expect(stub).toHaveBeenCalledWith(messageEvent);
  });

  test("passes JSON-RPC responses on to _handleResponse", () => {
    const spy = spyOn(ctx.mopidy, "_handleResponse");
    const message = {
      jsonrpc: "2.0",
      id: 1,
      result: null,
    };
    const messageEvent = { data: JSON.stringify(message) };

    ctx.mopidy._handleMessage(messageEvent);

    expect(spy).toHaveBeenCalledWith(message);
  });

  test("passes events on to _handleEvent", () => {
    const stub = spyOn(ctx.mopidy, "_handleEvent").mockImplementation(() => {});
    const message = {
      event: "track_playback_started",
      track: {},
    };
    const messageEvent = { data: JSON.stringify(message) };

    ctx.mopidy._handleMessage(messageEvent);

    expect(stub).toHaveBeenCalledWith(message);
  });

  test("logs unknown messages", () => {
    const messageEvent = { data: JSON.stringify({ foo: "bar" }) };

    ctx.mopidy._handleMessage(messageEvent);

    expect(warn).toHaveBeenCalledWith(
      `Unknown message type received. Message was: ${messageEvent.data}`
    );
  });

  test("logs JSON parsing errors", () => {
    const messageEvent = { data: "foobarbaz" };

    ctx.mopidy._handleMessage(messageEvent);

    expect(warn).toHaveBeenCalledWith(
      `WebSocket message parsing failed. Message was: ${messageEvent.data}`
    );
  });
});

describe("._handleResponse", () => {
  test("logs unexpected responses", () => {
    const responseMessage = {
      jsonrpc: "2.0",
      id: 1337,
      result: null,
    };

    ctx.mopidy._handleResponse(responseMessage);

    expect(warn).toHaveBeenCalledWith(
      "Unexpected response received. Message was:",
      responseMessage
    );
  });

  test("removes the matching request from the pending queue", () => {
    expect(Object.keys(ctx.mopidy._pendingRequests).length).toBe(0);
    ctx.mopidy._send({ method: "bar" });
    expect(Object.keys(ctx.mopidy._pendingRequests).length).toBe(1);

    ctx.mopidy._handleResponse({
      jsonrpc: "2.0",
      id: Object.keys(ctx.mopidy._pendingRequests)[0],
      result: "baz",
    });

    expect(Object.keys(ctx.mopidy._pendingRequests).length).toBe(0);
  });

  test("resolves requests which get results back", async () => {
    const promise = ctx.mopidy._send({ method: "bar" });
    const responseResult = {};
    const responseMessage = {
      jsonrpc: "2.0",
      id: Object.keys(ctx.mopidy._pendingRequests)[0],
      result: responseResult,
    };

    ctx.mopidy._handleResponse(responseMessage);

    expect.hasAssertions();
    const result = await promise;
    expect(result).toBe(responseResult);
  });

  test("rejects and logs requests which get errors back", async () => {
    const promise = ctx.mopidy._send({ method: "bar" });
    const responseError = {
      code: -32601,
      message: "Method not found",
      data: {},
    };
    const responseMessage = {
      jsonrpc: "2.0",
      id: Object.keys(ctx.mopidy._pendingRequests)[0],
      error: responseError,
    };

    ctx.mopidy._handleResponse(responseMessage);

    expect.hasAssertions();
    await promise.catch((error: any) => {
      expect(warn).toHaveBeenCalledWith(
        "Server returned error:",
        responseError
      );
      expect(error).toBeInstanceOf(Error);
      expect(error.code).toBe(responseError.code);
      expect(error.message).toBe(responseError.message);
      expect(error.data).toBe(responseError.data);
    });
  });

  test("rejects and logs requests which get errors without data", async () => {
    const promise = ctx.mopidy._send({ method: "bar" });
    const responseError = {
      code: -32601,
      message: "Method not found",
      // 'data' key intentionally missing
    };
    const responseMessage = {
      jsonrpc: "2.0",
      id: Object.keys(ctx.mopidy._pendingRequests)[0],
      error: responseError,
    };

    ctx.mopidy._handleResponse(responseMessage);

    expect.hasAssertions();
    await promise.catch((error: any) => {
      expect(warn).toHaveBeenCalledWith(
        "Server returned error:",
        responseError
      );
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(Mopidy.ServerError);
      expect(error.code).toBe(responseError.code);
      expect(error.message).toBe(responseError.message);
      expect(error.data).toBeUndefined();
    });
  });

  test("rejects and logs responses without result or error", async () => {
    const promise = ctx.mopidy._send({ method: "bar" });
    const responseMessage = {
      jsonrpc: "2.0",
      id: Object.keys(ctx.mopidy._pendingRequests)[0],
    };

    ctx.mopidy._handleResponse(responseMessage);

    expect.hasAssertions();
    await promise.catch((error: any) => {
      expect(warn).toHaveBeenCalledWith(
        "Response without 'result' or 'error' received. Message was:",
        responseMessage
      );
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe(
        "Response without 'result' or 'error' received"
      );
      expect(error.data.response).toBe(responseMessage);
    });
  });
});

describe("._handleEvent", () => {
  test("emits all server side events on 'event' event", () => {
    const spy = mock(() => {});
    ctx.mopidy.on("event", spy);
    const track = {};
    const message = {
      event: "track_playback_started",
      track,
    };

    ctx.mopidy._handleEvent(message);

    expect(spy).toHaveBeenCalledWith("event:trackPlaybackStarted", { track });
  });

  test("emits server side events on 'event:*' events", () => {
    const spy = mock(() => {});
    ctx.mopidy.on("event:trackPlaybackStarted", spy);
    const track = {};
    const message = {
      event: "track_playback_started",
      track,
    };

    ctx.mopidy._handleEvent(message);

    expect(spy).toHaveBeenCalledWith({ track });
  });
});

describe("._getApiSpec", () => {
  test("is called on 'websocket:open' event", () => {
    const spy = spyOn(ctx.mopidy, "_getApiSpec");
    ctx.mopidy._delegateEvents();

    ctx.mopidy.emit("websocket:open");

    expect(spy).toHaveBeenCalledWith();
  });

  test("gets API description from server and calls _createApi", async () => {
    const methods = {};
    const sendStub = spyOn(ctx.mopidy, "_send").mockReturnValue(
      Promise.resolve(methods)
    );
    const createApiStub = spyOn(ctx.mopidy, "_createApi").mockImplementation(
      () => {}
    );

    expect.hasAssertions();
    await ctx.mopidy._getApiSpec();
    expect(sendStub).toHaveBeenCalledWith({ method: "core.describe" });
    expect(createApiStub).toHaveBeenCalledWith(methods);
  });
});

describe("._createApi", () => {
  test("can create an API with methods on the root object", () => {
    expect(ctx.mopidy.hello).toBeUndefined();
    expect(ctx.mopidy.hi).toBeUndefined();

    ctx.mopidy._createApi({
      hello: {
        description: "Says hello",
        params: [],
      },
      hi: {
        description: "Says hi",
        params: [],
      },
    });

    expect(typeof ctx.mopidy.hello).toBe("function");
    expect(ctx.mopidy.hello.description).toBe("Says hello");
    expect(ctx.mopidy.hello.params).toEqual([]);
    expect(typeof ctx.mopidy.hi).toBe("function");
    expect(ctx.mopidy.hi.description).toBe("Says hi");
    expect(ctx.mopidy.hi.params).toEqual([]);
  });

  test("can create an API with methods on a sub-object", () => {
    expect(ctx.mopidy.hello).toBeUndefined();

    ctx.mopidy._createApi({
      "hello.world": {
        description: "Says hello to the world",
        params: [],
      },
    });

    expect(ctx.mopidy.hello).toBeDefined();
    expect(typeof ctx.mopidy.hello.world).toBe("function");
  });

  test("strips off 'core' from method paths", () => {
    expect(ctx.mopidy.hello).toBeUndefined();

    ctx.mopidy._createApi({
      "core.hello.world": {
        description: "Says hello to the world",
        params: [],
      },
    });

    expect(ctx.mopidy.hello).toBeDefined();
    expect(typeof ctx.mopidy.hello.world).toBe("function");
  });

  test("converts snake_case to camelCase", () => {
    expect(ctx.mopidy.mightyGreetings).toBeUndefined();

    ctx.mopidy._createApi({
      "mighty_greetings.hello_world": {
        description: "Says hello to the world",
        params: [],
      },
    });

    expect(ctx.mopidy.mightyGreetings).toBeDefined();
    expect(typeof ctx.mopidy.mightyGreetings.helloWorld).toBe("function");
  });

  test("triggers 'state' event when API is ready for use", () => {
    const spy = mock(() => {});
    ctx.mopidy.on("state", spy);

    ctx.mopidy._createApi({});

    expect(spy).toHaveBeenCalledWith("state:online");
  });

  test("triggers 'state:online' event when API is ready for use", () => {
    const spy = mock(() => {});
    ctx.mopidy.on("state:online", spy);

    ctx.mopidy._createApi({});

    expect(spy).toHaveBeenCalledWith();
  });
});

describe("API method calls", () => {
  beforeEach(() => {
    ctx.mopidy = new Mopidy({
      webSocket: ctx.openWebSocket,
    });
    ctx.mopidy._createApi({
      foo: {
        params: ["bar", "baz"],
      },
    });
    ctx.sendStub = spyOn(ctx.mopidy, "_send").mockImplementation(() => {});
  });

  test("sends no params if no arguments passed to function", () => {
    ctx.mopidy.foo();

    expect(ctx.sendStub).toHaveBeenCalledWith({ method: "foo" });
  });

  test("sends by-position if argument is a list", () => {
    ctx.mopidy.foo([31, 97]);

    expect(ctx.sendStub).toHaveBeenCalledWith({
      method: "foo",
      params: [31, 97],
    });
  });

  test("sends by-name if argument is an object", () => {
    ctx.mopidy.foo({ bar: 31, baz: 97 });

    expect(ctx.sendStub).toHaveBeenCalledWith({
      method: "foo",
      params: { bar: 31, baz: 97 },
    });
  });

  test("rejects with error if more than one argument", async () => {
    const promise = ctx.mopidy.foo([1, 2], { c: 3, d: 4 });

    expect.hasAssertions();
    await promise.catch((error: any) => {
      expect(ctx.sendStub).toHaveBeenCalledTimes(0);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe(
        "Expected zero arguments, a single array, or a single object."
      );
    });
  });

  test("rejects with error if string", async () => {
    const promise = ctx.mopidy.foo("hello");

    expect.hasAssertions();
    await promise.catch((error: any) => {
      expect(ctx.sendStub).toHaveBeenCalledTimes(0);
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(TypeError);
      expect(error.message).toBe("Expected an array or an object.");
    });
  });

  test("rejects with error if number", async () => {
    const promise = ctx.mopidy.foo(1337);

    expect.hasAssertions();
    await promise.catch((error: any) => {
      expect(ctx.sendStub).toHaveBeenCalledTimes(0);
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(TypeError);
      expect(error.message).toBe("Expected an array or an object.");
    });
  });

  test("rejects with error if null", async () => {
    const promise = ctx.mopidy.foo(null);

    expect.hasAssertions();
    await promise.catch((error: any) => {
      expect(ctx.sendStub).toHaveBeenCalledTimes(0);
      expect(error).toBeInstanceOf(TypeError);
      expect(error.message).toBe("Expected an array or an object.");
    });
  });

  test("rejects with error if boolean", async () => {
    const promise = ctx.mopidy.foo(true);

    expect.hasAssertions();
    await promise.catch((error: any) => {
      expect(ctx.sendStub).toHaveBeenCalledTimes(0);
      expect(error).toBeInstanceOf(TypeError);
      expect(error.message).toBe("Expected an array or an object.");
    });
  });
});

describe("._configure", () => {
  test("uses a custom webSocketUrl when provided", () => {
    const mopidy = new Mopidy({
      autoConnect: false,
      webSocketUrl: "ws://custom-host/custom-path",
    });

    expect(mopidy._settings.webSocketUrl).toBe("ws://custom-host/custom-path");
  });

  test("uses a custom backoffDelayMin when provided", () => {
    const mopidy = new Mopidy({
      autoConnect: false,
      backoffDelayMin: 500,
    });

    expect(mopidy._settings.backoffDelayMin).toBe(500);
  });

  test("uses a custom backoffDelayMax when provided", () => {
    const mopidy = new Mopidy({
      autoConnect: false,
      backoffDelayMax: 30000,
    });

    expect(mopidy._settings.backoffDelayMax).toBe(30000);
  });

  test("defaults backoffDelayMin to 1000", () => {
    const mopidy = new Mopidy({ autoConnect: false });

    expect(mopidy._settings.backoffDelayMin).toBe(1000);
  });

  test("defaults backoffDelayMax to 64000", () => {
    const mopidy = new Mopidy({ autoConnect: false });

    expect(mopidy._settings.backoffDelayMax).toBe(64000);
  });

  test("defaults autoConnect to true when not specified", () => {
    new Mopidy({});

    expect(ctx.WebSocketMock).toHaveBeenCalledTimes(1);
  });
});

describe("._getConsole", () => {
  test("uses the provided custom console", () => {
    const customConsole = {
      log: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
    };
    const mopidy = new Mopidy({
      autoConnect: false,
      console: customConsole as unknown as Console,
    });

    mopidy._handleWebSocketError({ message: "oops" } as Error);

    expect(customConsole.warn).toHaveBeenCalled();
  });

  test("falls back to the global console when none is provided", () => {
    const mopidy = new Mopidy({ autoConnect: false });

    expect(mopidy._console).toBe(console);
  });
});

describe(".connect (additional)", () => {
  test("closes a non-OPEN WebSocket and opens a new connection", () => {
    // Create a fresh instance that manages its own WebSocket (no pre-made socket).
    const mopidy = new Mopidy({ autoConnect: false });
    mopidy.connect(); // creates the first socket
    const firstSocket = mopidy._webSocket as any;
    // Simulate the socket moving to CONNECTING (e.g. lost and still connecting).
    firstSocket.readyState = ctx.WebSocketMock.CONNECTING;
    ctx.WebSocketMock.mockClear();

    mopidy.connect();

    expect(firstSocket.close).toHaveBeenCalled();
    expect(ctx.WebSocketMock).toHaveBeenCalledTimes(1);
  });
});

describe("._cleanup (additional)", () => {
  test("does not throw when there are no pending requests", () => {
    expect(Object.keys(ctx.mopidy._pendingRequests).length).toBe(0);

    expect(() => ctx.mopidy._cleanup({})).not.toThrow();
  });
});

describe("._getApiSpec (additional)", () => {
  test("calls _handleWebSocketError when _send fails", async () => {
    const error = new Error("Connection failed");
    spyOn(ctx.mopidy, "_send").mockReturnValue(Promise.reject(error));
    const handleErrorSpy = spyOn(
      ctx.mopidy,
      "_handleWebSocketError"
    ).mockImplementation(() => {});

    await ctx.mopidy._getApiSpec();

    expect(handleErrorSpy).toHaveBeenCalledWith(error);
  });
});

describe("._handleMessage (additional)", () => {
  test("rethrows non-SyntaxError exceptions", () => {
    const rangeError = new RangeError("unexpected internal error");
    const parseSpy = spyOn(JSON, "parse").mockImplementation(() => {
      throw rangeError;
    });

    expect(() => {
      ctx.mopidy._handleMessage({ data: "any" });
    }).toThrow(rangeError);

    parseSpy.mockRestore();
  });
});

describe("._handleEvent (additional)", () => {
  test("strips the event field and passes all other data fields through", () => {
    const spy = mock(() => {});
    ctx.mopidy.on("event:trackPlaybackEnded", spy);
    const tlTrack = { tlid: 42, track: {} };
    const message = {
      event: "track_playback_ended",
      tl_track: tlTrack,
      time_position: 12345,
    };

    ctx.mopidy._handleEvent(message);

    expect(spy).toHaveBeenCalledWith({
      tl_track: tlTrack,
      time_position: 12345,
    });
  });
});

describe("._createApi (additional)", () => {
  test("can create deeply nested API methods (4+ levels)", () => {
    ctx.mopidy._createApi({
      "core.a.b.c": {
        description: "A deep method",
        params: [],
      },
    });

    expect(ctx.mopidy.a).toBeDefined();
    expect(ctx.mopidy.a.b).toBeDefined();
    expect(typeof ctx.mopidy.a.b.c).toBe("function");
    expect(ctx.mopidy.a.b.c.description).toBe("A deep method");
  });
});

describe("Mopidy.ConnectionError", () => {
  test("is an Error subclass with the name 'ConnectionError'", () => {
    const error = new Mopidy.ConnectionError("connection lost");

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ConnectionError");
    expect(error.message).toBe("connection lost");
  });

  test("can store a closeEvent", () => {
    const error = new Mopidy.ConnectionError("closed");
    const closeEvent = { code: 1000 };
    error.closeEvent = closeEvent;

    expect(error.closeEvent).toBe(closeEvent);
  });
});

describe("Mopidy.ServerError", () => {
  test("is an Error subclass with the name 'ServerError'", () => {
    const error = new Mopidy.ServerError("method not found");

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ServerError");
    expect(error.message).toBe("method not found");
  });

  test("can store code and data", () => {
    const error = new Mopidy.ServerError("server error");
    error.code = -32601;
    error.data = { detail: "not found" };

    expect(error.code).toBe(-32601);
    expect(error.data).toEqual({ detail: "not found" });
  });
});
