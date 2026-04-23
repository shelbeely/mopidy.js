/* eslint no-new:off */

import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  mock,
  spyOn,
  jest,
} from "bun:test";
import Mopidy from "../src/index";

interface MockWebSocketInstance {
  close: ReturnType<typeof mock>;
  send: ReturnType<typeof mock>;
  readyState: number;
  onclose?: (e: CloseEvent | Record<string, unknown>) => void;
  onerror?: (e: Event | Record<string, unknown>) => void;
  onopen?: () => void;
  onmessage?: (e: MessageEvent) => void;
}

let mopidy: Mopidy;
let openWebSocket: MockWebSocketInstance;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let WebSocketMock: any;

const warn = spyOn(console, "warn").mockImplementation(() => {});

beforeEach(() => {
  jest.useFakeTimers();

  // Create a generic WebSocket mock
  WebSocketMock = mock();
  WebSocketMock.CONNECTING = 0;
  WebSocketMock.OPEN = 1;
  WebSocketMock.CLOSING = 2;
  WebSocketMock.CLOSED = 3;
  WebSocketMock.mockImplementation(() => {
    const ws: MockWebSocketInstance = {
      close: mock(),
      send: mock(),
      readyState: WebSocketMock.CLOSED,
    };
    ws.close.mockImplementation(() => {
      ws.onclose?.({} as CloseEvent);
    });
    return ws;
  });

  // Use the WebSocketMock to create all new WebSockets
  Mopidy.WebSocket = WebSocketMock as typeof globalThis.WebSocket;

  // Create Mopidy instance good enough for most tests
  openWebSocket = new WebSocketMock();
  openWebSocket.readyState = WebSocketMock.OPEN;
  WebSocketMock.mockClear();
  mopidy = new Mopidy({
    webSocket: openWebSocket as unknown as WebSocket,
  });

  // Clear mocks with state that can cross between tests
  warn.mockClear();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("constructor", () => {
  test("connects when autoConnect is true", () => {
    new Mopidy({
      autoConnect: true,
    });

    const currentHost =
      (typeof document !== "undefined" && document.location.host) ||
      "localhost";

    expect(Mopidy.WebSocket).toHaveBeenCalledWith(
      `ws://${currentHost}/mopidy/ws`
    );
  });

  test("does not connect when autoConnect is false", () => {
    new Mopidy({
      autoConnect: false,
    });

    expect(Mopidy.WebSocket).not.toBeCalled();
  });

  test("does not connect when passed a WebSocket", () => {
    new Mopidy({
      webSocket: {} as WebSocket,
    });

    expect(Mopidy.WebSocket).not.toBeCalled();
  });
});

describe(".off", () => {
  test("with no args works", () => {
    const removeAllStub = spyOn(mopidy, "removeAllListeners");

    mopidy.off();

    expect(removeAllStub).toBeCalledWith();
  });

  test("with an event name works", () => {
    const removeAllStub = spyOn(mopidy, "removeAllListeners");

    mopidy.off("some-event");

    expect(removeAllStub).toBeCalledWith("some-event");
  });

  test("with a listener fails", () => {
    const listener = () => {};
    const removeAllStub = spyOn(mopidy, "removeAllListeners");

    try {
      mopidy.off(listener as unknown as string);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        "Expected no arguments, a string, or a string and a listener."
      );
    }

    expect(removeAllStub).not.toBeCalled();
  });

  test("with an event name and a listener works", () => {
    const listener = () => {};
    const removeStub = spyOn(mopidy, "removeListener");

    mopidy.off("some-event", listener);

    expect(removeStub).toBeCalledWith("some-event", listener);
  });
});

describe(".connect", () => {
  test("connects when autoConnect is false", () => {
    const localMopidy = new Mopidy({
      autoConnect: false,
    });
    expect(Mopidy.WebSocket).not.toBeCalled();

    localMopidy.connect();

    const currentHost =
      (typeof document !== "undefined" && document.location.host) ||
      "localhost";

    expect(Mopidy.WebSocket).toHaveBeenCalledWith(
      `ws://${currentHost}/mopidy/ws`
    );
  });

  test("does nothing when the WebSocket is open", () => {
    expect(mopidy._webSocket).toBe(openWebSocket);
    expect(openWebSocket.readyState).toBe(Mopidy.WebSocket.OPEN);

    mopidy.connect();

    expect(openWebSocket.close).not.toBeCalled();
    expect(Mopidy.WebSocket).not.toBeCalled();
  });
});

describe("WebSocket events", () => {
  test("emits 'websocket:close' when connection is closed", () => {
    const spy = mock();
    mopidy.on("websocket:close", spy);

    const closeEvent = {};
    (mopidy._webSocket as unknown as MockWebSocketInstance).onclose!(
      closeEvent as CloseEvent
    );

    expect(spy).toBeCalledWith(closeEvent);
  });

  test("emits 'websocket:error' when errors occurs", () => {
    const spy = mock();
    mopidy.on("websocket:error", spy);

    const errorEvent = {};
    (mopidy._webSocket as unknown as MockWebSocketInstance).onerror!(
      errorEvent as Event
    );

    expect(spy).toBeCalledWith(errorEvent);
  });

  test("emits 'websocket:incomingMessage' when a message arrives", () => {
    const spy = mock();
    mopidy.on("websocket:incomingMessage", spy);

    const messageEvent = { data: "this is a message" };
    (mopidy._webSocket as unknown as MockWebSocketInstance).onmessage!(
      messageEvent as MessageEvent
    );

    expect(spy).toBeCalledWith(messageEvent);
  });

  test("emits 'websocket:open' when connection is opened", () => {
    const spy = mock();
    mopidy.on("websocket:open", spy);

    (mopidy._webSocket as unknown as MockWebSocketInstance).onopen!();

    expect(spy).toBeCalledWith();
  });
});

describe("._cleanup", () => {
  beforeEach(() => {
    mopidy.removeAllListeners("state:offline");
  });

  test("is called on 'websocket:close' event", () => {
    const closeEvent = {};
    const cleanup = spyOn(mopidy, "_cleanup");
    mopidy._delegateEvents();

    mopidy.emit("websocket:close", closeEvent);

    expect(cleanup).toBeCalledWith(closeEvent);
  });

  test("rejects all pending requests", (done) => {
    const closeEvent = {};
    expect(Object.keys(mopidy._pendingRequests).length).toBe(0);

    const promise1 = mopidy._send({ method: "foo" });
    const promise2 = mopidy._send({ method: "bar" });
    expect(Object.keys(mopidy._pendingRequests).length).toBe(2);

    mopidy._cleanup(closeEvent as CloseEvent);

    expect(Object.keys(mopidy._pendingRequests).length).toBe(0);
    Promise.all([
      promise1.catch((error) => error),
      promise2.catch((error) => error),
    ])
      .then((errors) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        errors.forEach((error: any) => {
          expect(error).toBeInstanceOf(Error);
          expect(error).toBeInstanceOf(Mopidy.ConnectionError);
          expect(error.message).toBe("WebSocket closed");
          expect(error.closeEvent).toBe(closeEvent);
        });
      })
      .then(() => done());
  });

  test("emits 'state' event when done", () => {
    const spy = mock();
    mopidy.on("state", spy);

    mopidy._cleanup({} as CloseEvent);

    expect(spy).toBeCalledWith("state:offline");
  });

  test("emits 'state:offline' event when done", () => {
    const spy = mock();
    mopidy.on("state:offline", spy);

    mopidy._cleanup({} as CloseEvent);

    expect(spy).toBeCalledWith();
  });
});

describe("._reconnect", () => {
  test("is called when the state changes to offline", () => {
    const spy = spyOn(mopidy, "_reconnect");
    mopidy._delegateEvents();

    mopidy.emit("state:offline");
    jest.runOnlyPendingTimers();

    expect(spy).toBeCalledWith();
  });

  test("tries to connect after an increasing backoff delay", () => {
    const connectStub = spyOn(mopidy, "connect").mockImplementation(() => {});
    const stateSpy = mock();
    mopidy.on("state", stateSpy);
    const pendingSpy = mock();
    mopidy.on("reconnectionPending", pendingSpy);
    const reconnectingSpy = mock();
    mopidy.on("reconnecting", reconnectingSpy);

    expect(connectStub).toBeCalledTimes(0);

    mopidy._reconnect();
    jest.runOnlyPendingTimers();
    expect(stateSpy).toBeCalledWith("reconnectionPending", {
      timeToAttempt: 1000,
    });
    expect(pendingSpy).toBeCalledWith({ timeToAttempt: 1000 });
    jest.advanceTimersByTime(0);
    expect(connectStub).toBeCalledTimes(0);
    jest.advanceTimersByTime(1000);
    expect(connectStub).toBeCalledTimes(1);
    expect(stateSpy).toBeCalledWith("reconnecting");
    expect(reconnectingSpy).toBeCalledWith();

    stateSpy.mockClear();
    pendingSpy.mockClear();
    reconnectingSpy.mockClear();
    mopidy._reconnect();
    jest.runOnlyPendingTimers();
    expect(stateSpy).toBeCalledWith("reconnectionPending", {
      timeToAttempt: 2000,
    });
    expect(pendingSpy).toBeCalledWith({ timeToAttempt: 2000 });
    expect(connectStub).toBeCalledTimes(1);
    jest.advanceTimersByTime(0);
    expect(connectStub).toBeCalledTimes(1);
    jest.advanceTimersByTime(1000);
    expect(connectStub).toBeCalledTimes(1);
    jest.advanceTimersByTime(1000);
    expect(connectStub).toBeCalledTimes(2);
    expect(stateSpy).toBeCalledWith("reconnecting");
    expect(reconnectingSpy).toBeCalledWith();

    stateSpy.mockClear();
    pendingSpy.mockClear();
    reconnectingSpy.mockClear();
    mopidy._reconnect();
    jest.runOnlyPendingTimers();
    expect(stateSpy).toBeCalledWith("reconnectionPending", {
      timeToAttempt: 4000,
    });
    expect(pendingSpy).toBeCalledWith({ timeToAttempt: 4000 });
    expect(connectStub).toBeCalledTimes(2);
    jest.advanceTimersByTime(0);
    expect(connectStub).toBeCalledTimes(2);
    jest.advanceTimersByTime(2000);
    expect(connectStub).toBeCalledTimes(2);
    jest.advanceTimersByTime(2000);
    expect(connectStub).toBeCalledTimes(3);
    expect(stateSpy).toBeCalledWith("reconnecting");
    expect(reconnectingSpy).toBeCalledWith();
  });

  test("tries to connect at least about once per minute", () => {
    const connectStub = spyOn(mopidy, "connect").mockImplementation(() => {});
    const stateSpy = mock();
    mopidy.on("state", stateSpy);
    const pendingSpy = mock();
    mopidy.on("reconnectionPending", pendingSpy);
    mopidy._backoffDelay = mopidy._settings.backoffDelayMax;

    expect(connectStub).toBeCalledTimes(0);

    mopidy._reconnect();
    jest.runOnlyPendingTimers();
    expect(stateSpy).toBeCalledWith("reconnectionPending", {
      timeToAttempt: 64000,
    });
    expect(pendingSpy).toBeCalledWith({ timeToAttempt: 64000 });
    jest.advanceTimersByTime(0);
    expect(connectStub).toBeCalledTimes(0);
    jest.advanceTimersByTime(64000);
    expect(connectStub).toBeCalledTimes(1);

    stateSpy.mockClear();
    pendingSpy.mockClear();
    mopidy._reconnect();
    jest.runOnlyPendingTimers();
    expect(stateSpy).toBeCalledWith("reconnectionPending", {
      timeToAttempt: 64000,
    });
    expect(pendingSpy).toBeCalledWith({ timeToAttempt: 64000 });
    expect(connectStub).toBeCalledTimes(1);
    jest.advanceTimersByTime(0);
    expect(connectStub).toBeCalledTimes(1);
    jest.advanceTimersByTime(64000);
    expect(connectStub).toBeCalledTimes(2);
  });

  test("emits reconnectionPending after state:offline event", () => {
    const callOrder: string[] = [];
    const offlineSpy = mock(() => {
      callOrder.push("offline");
    });
    const reconnectionSpy = mock(() => {
      callOrder.push("reconnection");
    });
    mopidy.on("state:offline", offlineSpy);
    mopidy.on("reconnectionPending", reconnectionSpy);

    mopidy.emit("websocket:close");

    expect(offlineSpy).toBeCalledWith();

    // Before we check the reconnection spy we have to run pending timers again,
    // because the reconnection happens in an async listener of the
    // state:offline event.
    jest.runOnlyPendingTimers();

    expect(reconnectionSpy).toBeCalledWith({ timeToAttempt: 1000 });
    expect(callOrder.indexOf("offline")).toBeLessThan(
      callOrder.indexOf("reconnection")
    );
  });
});

describe("._resetBackoffDelay", () => {
  test("is called on 'websocket:open' event", () => {
    const spy = spyOn(mopidy, "_resetBackoffDelay");
    mopidy._delegateEvents();

    mopidy.emit("websocket:open");

    expect(spy).toBeCalled();
  });

  test("resets the backoff delay to the minimum value", () => {
    mopidy._backoffDelay = mopidy._settings.backoffDelayMax;

    mopidy._resetBackoffDelay();

    expect(mopidy._backoffDelay).toBe(mopidy._settings.backoffDelayMin);
  });
});

describe(".close", () => {
  test("unregisters reconnection hooks", () => {
    const offSpy = spyOn(mopidy, "off");
    const reconnectingSpy = mock();
    mopidy.on("reconnecting", reconnectingSpy);
    const reconnectionPendingSpy = mock();
    mopidy.on("reconnectionPending", reconnectionPendingSpy);

    mopidy.close();

    expect(offSpy).toBeCalledWith("state:offline", mopidy._reconnect);

    jest.runOnlyPendingTimers(); // Handle the "state:offline" event

    expect(reconnectingSpy).not.toHaveBeenCalled();
    expect(reconnectionPendingSpy).not.toHaveBeenCalled();
  });

  test("closes the WebSocket", () => {
    mopidy.close();

    expect(
      (mopidy._webSocket as unknown as MockWebSocketInstance).close
    ).toBeCalledWith();
  });

  test("close without an open WebSocket does not fail", () => {
    const localMopidy = new Mopidy({ autoConnect: false });

    localMopidy.close(); // No error thrown
  });
});

describe("._handleWebSocketError", () => {
  test("is called on 'websocket:error' event", () => {
    const error = {};
    const spy = spyOn(mopidy, "_handleWebSocketError");
    mopidy._delegateEvents();

    mopidy.emit("websocket:error", error);

    expect(spy).toBeCalledWith(error);
  });

  test("without stack logs the error to the console", () => {
    const error = {};

    mopidy._handleWebSocketError(error as Event);

    expect(warn).toBeCalledWith("WebSocket error:", error);
  });

  test("with stack logs the error to the console", () => {
    const error = { stack: "foo" };

    mopidy._handleWebSocketError(error as Event & { stack?: string });

    expect(warn).toBeCalledWith("WebSocket error:", error.stack);
  });
});

describe("._send", () => {
  test("adds JSON-RPC fields to the message", () => {
    spyOn(mopidy, "_nextRequestId").mockImplementation(() => 1);
    const spy = spyOn(JSON, "stringify");

    mopidy._send({ method: "foo" });

    expect(spy).toBeCalledWith({
      jsonrpc: "2.0",
      id: 1,
      method: "foo",
    });
  });

  test("adds a resolver to the pending requests queue", () => {
    spyOn(mopidy, "_nextRequestId").mockImplementation(() => 1);
    expect(Object.keys(mopidy._pendingRequests).length).toBe(0);

    mopidy._send({ method: "foo" });

    expect(Object.keys(mopidy._pendingRequests).length).toBe(1);
    expect(mopidy._pendingRequests[1].resolve).toBeDefined();
  });

  test("sends message on the WebSocket", () => {
    expect(
      (mopidy._webSocket as unknown as MockWebSocketInstance).send
    ).toBeCalledTimes(0);

    mopidy._send({ method: "foo" });

    expect(
      (mopidy._webSocket as unknown as MockWebSocketInstance).send
    ).toBeCalledTimes(1);
  });

  test("emits a 'websocket:outgoingMessage' event", () => {
    const spy = mock();
    mopidy.on("websocket:outgoingMessage", spy);
    spyOn(mopidy, "_nextRequestId").mockImplementation(() => 1);

    mopidy._send({ method: "foo" });

    expect(spy).toBeCalledWith({
      jsonrpc: "2.0",
      id: 1,
      method: "foo",
    });
  });

  test("immediately rejects request if CONNECTING", (done) => {
    (mopidy._webSocket as unknown as MockWebSocketInstance).readyState =
      Mopidy.WebSocket.CONNECTING;

    const promise = mopidy._send({ method: "foo" });

    expect.hasAssertions();
    promise
      .catch((error) => {
        expect(
          (mopidy._webSocket as unknown as MockWebSocketInstance).send
        ).toBeCalledTimes(0);
        expect(error).toBeInstanceOf(Error);
        expect(error).toBeInstanceOf(Mopidy.ConnectionError);
        expect((error as Error).message).toBe(
          "WebSocket is still connecting"
        );
      })
      .then(() => done());
  });

  test("immediately rejects request if CLOSING", (done) => {
    (mopidy._webSocket as unknown as MockWebSocketInstance).readyState =
      Mopidy.WebSocket.CLOSING;

    const promise = mopidy._send({ method: "foo" });

    expect.hasAssertions();
    promise
      .catch((error) => {
        expect(
          (mopidy._webSocket as unknown as MockWebSocketInstance).send
        ).toBeCalledTimes(0);
        expect(error).toBeInstanceOf(Error);
        expect(error).toBeInstanceOf(Mopidy.ConnectionError);
        expect((error as Error).message).toBe("WebSocket is closing");
      })
      .then(() => done());
  });

  test("immediately rejects request if CLOSED", (done) => {
    (mopidy._webSocket as unknown as MockWebSocketInstance).readyState =
      Mopidy.WebSocket.CLOSED;

    const promise = mopidy._send({ method: "foo" });

    expect.hasAssertions();
    promise
      .catch((error) => {
        expect(
          (mopidy._webSocket as unknown as MockWebSocketInstance).send
        ).toBeCalledTimes(0);
        expect(error).toBeInstanceOf(Error);
        expect(error).toBeInstanceOf(Mopidy.ConnectionError);
        expect((error as Error).message).toBe("WebSocket is closed");
      })
      .then(() => done());
  });
});

describe("._nextRequestId", () => {
  test("returns an ever increasing ID", () => {
    const base = mopidy._nextRequestId();
    expect(mopidy._nextRequestId()).toBe(base + 1);
    expect(mopidy._nextRequestId()).toBe(base + 2);
    expect(mopidy._nextRequestId()).toBe(base + 3);
  });
});

describe("._handleMessage", () => {
  test("is called on 'websocket:incomingMessage' event", () => {
    const messageEvent = {};
    const stub = spyOn(mopidy, "_handleMessage").mockImplementation(() => {});
    mopidy._delegateEvents();

    mopidy.emit("websocket:incomingMessage", messageEvent);

    expect(stub).toBeCalledWith(messageEvent);
  });

  test("passes JSON-RPC responses on to _handleResponse", () => {
    const spy = spyOn(mopidy, "_handleResponse");
    const message = {
      jsonrpc: "2.0",
      id: 1,
      result: null,
    };
    const messageEvent = { data: JSON.stringify(message) };

    mopidy._handleMessage(messageEvent as MessageEvent);

    expect(spy).toBeCalledWith(message);
  });

  test("passes events on to _handleEvent", () => {
    const stub = spyOn(mopidy, "_handleEvent").mockImplementation(() => {});
    const message = {
      event: "track_playback_started",
      track: {},
    };
    const messageEvent = { data: JSON.stringify(message) };

    mopidy._handleMessage(messageEvent as MessageEvent);

    expect(stub).toBeCalledWith(message);
  });

  test("logs unknown messages", () => {
    const messageEvent = { data: JSON.stringify({ foo: "bar" }) };

    mopidy._handleMessage(messageEvent as MessageEvent);

    expect(warn).toBeCalledWith(
      `Unknown message type received. Message was: ${messageEvent.data}`
    );
  });

  test("logs JSON parsing errors", () => {
    const messageEvent = { data: "foobarbaz" };

    mopidy._handleMessage(messageEvent as MessageEvent);

    expect(warn).toBeCalledWith(
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

    mopidy._handleResponse(responseMessage);

    expect(warn).toBeCalledWith(
      "Unexpected response received. Message was:",
      responseMessage
    );
  });

  test("removes the matching request from the pending queue", () => {
    expect(Object.keys(mopidy._pendingRequests).length).toBe(0);
    mopidy._send({ method: "bar" });
    expect(Object.keys(mopidy._pendingRequests).length).toBe(1);

    mopidy._handleResponse({
      jsonrpc: "2.0",
      id: Object.keys(mopidy._pendingRequests)[0],
      result: "baz",
    });

    expect(Object.keys(mopidy._pendingRequests).length).toBe(0);
  });

  test("resolves requests which get results back", (done) => {
    const promise = mopidy._send({ method: "bar" });
    const responseResult = {};
    const responseMessage = {
      jsonrpc: "2.0",
      id: Object.keys(mopidy._pendingRequests)[0],
      result: responseResult,
    };

    mopidy._handleResponse(responseMessage);

    expect.hasAssertions();
    promise
      .then((result) => {
        expect(result).toBe(responseResult);
      })
      .then(() => done());
  });

  test("rejects and logs requests which get errors back", (done) => {
    const promise = mopidy._send({ method: "bar" });
    const responseError = {
      code: -32601,
      message: "Method not found",
      data: {},
    };
    const responseMessage = {
      jsonrpc: "2.0",
      id: Object.keys(mopidy._pendingRequests)[0],
      error: responseError,
    };

    mopidy._handleResponse(responseMessage);

    expect.hasAssertions();
    promise
      .catch((error) => {
        expect(warn).toBeCalledWith("Server returned error:", responseError);
        expect(error).toBeInstanceOf(Error);
        expect((error as InstanceType<typeof Mopidy.ServerError>).code).toBe(
          responseError.code
        );
        expect((error as Error).message).toBe(responseError.message);
        expect((error as InstanceType<typeof Mopidy.ServerError>).data).toBe(
          responseError.data
        );
      })
      .then(() => done());
  });

  test("rejects and logs requests which get errors without data", (done) => {
    const promise = mopidy._send({ method: "bar" });
    const responseError = {
      code: -32601,
      message: "Method not found",
      // 'data' key intentionally missing
    };
    const responseMessage = {
      jsonrpc: "2.0",
      id: Object.keys(mopidy._pendingRequests)[0],
      error: responseError,
    };

    mopidy._handleResponse(responseMessage);

    expect.hasAssertions();
    promise
      .catch((error) => {
        expect(warn).toBeCalledWith("Server returned error:", responseError);
        expect(error).toBeInstanceOf(Error);
        expect(error).toBeInstanceOf(Mopidy.ServerError);
        expect((error as InstanceType<typeof Mopidy.ServerError>).code).toBe(
          responseError.code
        );
        expect((error as Error).message).toBe(responseError.message);
        expect(
          (error as InstanceType<typeof Mopidy.ServerError>).data
        ).toBeUndefined();
      })
      .then(() => done());
  });

  test("rejects and logs responses without result or error", (done) => {
    const promise = mopidy._send({ method: "bar" });
    const responseMessage = {
      jsonrpc: "2.0",
      id: Object.keys(mopidy._pendingRequests)[0],
    };

    mopidy._handleResponse(responseMessage);

    expect.hasAssertions();
    promise
      .catch((error) => {
        expect(warn).toBeCalledWith(
          "Response without 'result' or 'error' received. Message was:",
          responseMessage
        );
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(
          "Response without 'result' or 'error' received"
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((error as any).data.response).toBe(responseMessage);
      })
      .then(() => done());
  });
});

describe("._handleEvent", () => {
  test("emits all server side events on 'event' event", () => {
    const spy = mock();
    mopidy.on("event", spy);
    const track = {};
    const message = {
      event: "track_playback_started",
      track,
    };

    mopidy._handleEvent(message);

    expect(spy).toBeCalledWith("event:trackPlaybackStarted", { track });
  });

  test("emits server side events on 'event:*' events", () => {
    const spy = mock();
    mopidy.on("event:trackPlaybackStarted", spy);
    const track = {};
    const message = {
      event: "track_playback_started",
      track,
    };

    mopidy._handleEvent(message);

    expect(spy).toBeCalledWith({ track });
  });
});

describe("._getApiSpec", () => {
  test("is called on 'websocket:open' event", () => {
    const spy = spyOn(mopidy, "_getApiSpec");
    mopidy._delegateEvents();

    mopidy.emit("websocket:open");

    expect(spy).toBeCalledWith();
  });

  test("gets API description from server and calls _createApi", (done) => {
    const methods = {};
    const sendStub = spyOn(mopidy, "_send").mockReturnValue(
      Promise.resolve(methods)
    );
    const createApiStub = spyOn(mopidy, "_createApi").mockImplementation(
      () => {}
    );

    expect.hasAssertions();
    mopidy
      ._getApiSpec()
      .then(() => {
        expect(sendStub).toBeCalledWith({ method: "core.describe" });
        expect(createApiStub).toBeCalledWith(methods);
      })
      .then(() => done());
  });
});

describe("._createApi", () => {
  test("can create an API with methods on the root object", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mopidy as any).hello).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mopidy as any).hi).toBeUndefined();

    mopidy._createApi({
      hello: {
        description: "Says hello",
        params: [],
      },
      hi: {
        description: "Says hi",
        params: [],
      },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(typeof (mopidy as any).hello).toBe("function");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mopidy as any).hello.description).toBe("Says hello");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mopidy as any).hello.params).toEqual([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(typeof (mopidy as any).hi).toBe("function");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mopidy as any).hi.description).toBe("Says hi");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mopidy as any).hi.params).toEqual([]);
  });

  test("can create an API with methods on a sub-object", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mopidy as any).hello).toBeUndefined();

    mopidy._createApi({
      "hello.world": {
        description: "Says hello to the world",
        params: [],
      },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mopidy as any).hello).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(typeof (mopidy as any).hello.world).toBe("function");
  });

  test("strips off 'core' from method paths", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mopidy as any).hello).toBeUndefined();

    mopidy._createApi({
      "core.hello.world": {
        description: "Says hello to the world",
        params: [],
      },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mopidy as any).hello).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(typeof (mopidy as any).hello.world).toBe("function");
  });

  test("converts snake_case to camelCase", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mopidy as any).mightyGreetings).toBeUndefined();

    mopidy._createApi({
      "mighty_greetings.hello_world": {
        description: "Says hello to the world",
        params: [],
      },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mopidy as any).mightyGreetings).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(typeof (mopidy as any).mightyGreetings.helloWorld).toBe("function");
  });

  test("triggers 'state' event when API is ready for use", () => {
    const spy = mock();
    mopidy.on("state", spy);

    mopidy._createApi({});

    expect(spy).toBeCalledWith("state:online");
  });

  test("triggers 'state:online' event when API is ready for use", () => {
    const spy = mock();
    mopidy.on("state:online", spy);

    mopidy._createApi({});

    expect(spy).toBeCalledWith();
  });
});

describe("API method calls", () => {
  let sendStub: ReturnType<typeof spyOn>;

  beforeEach(() => {
    mopidy = new Mopidy({
      webSocket: openWebSocket as unknown as WebSocket,
    });
    mopidy._createApi({
      foo: {
        description: "",
        params: ["bar", "baz"],
      },
    });
    sendStub = spyOn(mopidy, "_send").mockImplementation(
      () => undefined as unknown as Promise<unknown>
    );
  });

  test("sends no params if no arguments passed to function", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mopidy as any).foo();

    expect(sendStub).toBeCalledWith({ method: "foo" });
  });

  test("sends by-position if argument is a list", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mopidy as any).foo([31, 97]);

    expect(sendStub).toBeCalledWith({
      method: "foo",
      params: [31, 97],
    });
  });

  test("sends by-name if argument is an object", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mopidy as any).foo({ bar: 31, baz: 97 });

    expect(sendStub).toBeCalledWith({
      method: "foo",
      params: { bar: 31, baz: 97 },
    });
  });

  test("rejects with error if more than one argument", (done) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const promise = (mopidy as any).foo([1, 2], { c: 3, d: 4 });

    expect.hasAssertions();
    promise
      .catch((error: unknown) => {
        expect(sendStub).toBeCalledTimes(0);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(
          "Expected zero arguments, a single array, or a single object."
        );
      })
      .then(() => done());
  });

  test("rejects with error if string", (done) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const promise = (mopidy as any).foo("hello");

    expect.hasAssertions();
    promise
      .catch((error: unknown) => {
        expect(sendStub).toBeCalledTimes(0);
        expect(error).toBeInstanceOf(Error);
        expect(error).toBeInstanceOf(TypeError);
        expect((error as Error).message).toBe("Expected an array or an object.");
      })
      .then(() => done());
  });

  test("rejects with error if number", (done) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const promise = (mopidy as any).foo(1337);

    expect.hasAssertions();
    promise
      .catch((error: unknown) => {
        expect(sendStub).toBeCalledTimes(0);
        expect(error).toBeInstanceOf(Error);
        expect(error).toBeInstanceOf(TypeError);
        expect((error as Error).message).toBe("Expected an array or an object.");
      })
      .then(() => done());
  });
});
