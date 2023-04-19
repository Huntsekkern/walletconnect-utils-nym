import { EventEmitter } from "events";
import { safeJsonParse, safeJsonStringify } from "@walletconnect/safe-json";
import {
  formatJsonRpcError,
  IJsonRpcConnection,
  JsonRpcPayload,
  isReactNative,
  isWsUrl,
  isLocalhostUrl,
  parseConnectionError,
} from "@walletconnect/jsonrpc-utils";

// Source: https://nodejs.org/api/events.html#emittersetmaxlistenersn
const EVENT_EMITTER_MAX_LISTENERS_DEFAULT = 10;

const resolveWebSocketImplementation = () => {
  // TODO maybe HERE
  // So the first two if statements are a way to check if the code is being run in a browser (likely for the browser extensions)
  // And only if not, to default to the node.js implementation of WebSockets (require("ws")).
  // I should take care of both cases, which makes it trickier.
  if (typeof global !== "undefined" && typeof global.WebSocket !== "undefined") {
    return global.WebSocket;
  }
  if (typeof window !== "undefined" && typeof window.WebSocket !== "undefined") {
    return window.WebSocket;
  }

  return require("ws");
};

const isBrowser = () => typeof window !== "undefined";

const WS = resolveWebSocketImplementation();

export class WsConnection implements IJsonRpcConnection {
  // TODO check the eventEmitter too. While not directly leaking, even printing things to the console may want to be minimised?
  public events = new EventEmitter();

  // TODO maybe HERE, or at least check all methods calling it!
  // A nice solution could be to create a wrapper around the WebSocket instead of wrapping the calls individually.
  // I should wrap at least close, send
  private socket: WebSocket | undefined;

  private registering = false;

  constructor(public url: string) {
    if (!isWsUrl(url)) {
      throw new Error(`Provided URL is not compatible with WebSocket connection: ${url}`);
    }
    this.url = url;
  }

  get connected(): boolean {
    return typeof this.socket !== "undefined";
  }

  get connecting(): boolean {
    return this.registering;
  }

  public on(event: string, listener: any): void {
    this.events.on(event, listener);
  }

  public once(event: string, listener: any): void {
    this.events.once(event, listener);
  }

  public off(event: string, listener: any): void {
    this.events.off(event, listener);
  }

  public removeListener(event: string, listener: any): void {
    this.events.removeListener(event, listener);
  }

  public async open(url: string = this.url): Promise<void> {
    await this.register(url);
  }

  public async close(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (typeof this.socket === "undefined") {
        reject(new Error("Connection already closed"));
        return;
      }

      this.socket.onclose = event => {
        this.onClose(event);
        resolve();
      };

      // TODO HERE
      this.socket.close();
    });
  }

  public async send(payload: JsonRpcPayload, context?: any): Promise<void> {
    if (typeof this.socket === "undefined") {
      // TODO HERE
      this.socket = await this.register();
    }
    try {
      // TODO HERE
      // send takes several options, but in this case a string. This indicates again that this is only the payload,
      // and either I modify the send function/WS class to take a fixed url, or I modify the url being passed as an arg from a higher level.
      // But changing the url to the gateway is not enough! I need to call nym SDK which is a send too instead.
      this.socket.send(safeJsonStringify(payload));
    } catch (e) {
      this.onError(payload.id, e as Error);
    }
  }

  // ---------- Private ----------------------------------------------- //

  private register(url = this.url): Promise<WebSocket> {
    if (!isWsUrl(url)) {
      throw new Error(`Provided URL is not compatible with WebSocket connection: ${url}`);
    }
    if (this.registering) {
      const currentMaxListeners = this.events.getMaxListeners();
      if (
        this.events.listenerCount("register_error") >= currentMaxListeners ||
        this.events.listenerCount("open") >= currentMaxListeners
      ) {
        this.events.setMaxListeners(currentMaxListeners + 1);
      }
      return new Promise((resolve, reject) => {
        this.events.once("register_error", error => {
          this.resetMaxListeners();
          reject(error);
        });
        this.events.once("open", () => {
          this.resetMaxListeners();
          if (typeof this.socket === "undefined") {
            return reject(new Error("WebSocket connection is missing or invalid"));
          }
          resolve(this.socket);
        });
      });
    }
    this.url = url;
    this.registering = true;

    return new Promise((resolve, reject) => {
      const opts = !isReactNative() ? { rejectUnauthorized: !isLocalhostUrl(url) } : undefined;
      // TODO HERE
      const socket: WebSocket = new WS(url, [], opts);
      if (isBrowser()) {
        socket.onerror = (event: Event) => {
          const errorEvent = event as ErrorEvent;
          reject(this.emitError(errorEvent.error));
        };
      } else {
        (socket as any).on("error", (errorEvent: any) => {
          reject(this.emitError(errorEvent));
        });
      }
      socket.onopen = () => {
        this.onOpen(socket);
        resolve(socket);
      };
    });
  }

  private onOpen(socket: WebSocket) {
    // TODO HERE ??
    socket.onmessage = (event: MessageEvent) => this.onPayload(event);
    socket.onclose = event => this.onClose(event);
    this.socket = socket;
    this.registering = false;
    this.events.emit("open");
  }

  private onClose(event: CloseEvent) {
    this.socket = undefined;
    this.registering = false;
    this.events.emit("close", event);
  }

  private onPayload(e: { data: any }) {
    if (typeof e.data === "undefined") return;
    const payload: JsonRpcPayload = typeof e.data === "string" ? safeJsonParse(e.data) : e.data;
    // TODO HERE there must be something going on here, and then potentially all the events.emit. Or is it just that when a payload is received, we print it to the console.log??
    this.events.emit("payload", payload);
  }

  private onError(id: number, e: Error) {
    const error = this.parseError(e);
    const message = error.message || error.toString();
    const payload = formatJsonRpcError(id, message);
    this.events.emit("payload", payload);
  }

  private parseError(e: Error, url = this.url) {
    return parseConnectionError(e, url, "WS");
  }

  private resetMaxListeners() {
    if (this.events.getMaxListeners() > EVENT_EMITTER_MAX_LISTENERS_DEFAULT) {
      this.events.setMaxListeners(EVENT_EMITTER_MAX_LISTENERS_DEFAULT);
    }
  }

  private emitError(errorEvent: Error) {
    const error = this.parseError(
      new Error(errorEvent?.message || `WebSocket connection failed for URL: ${this.url}`),
    );
    this.events.emit("register_error", error);
    return error;
  }
}

export default WsConnection;
