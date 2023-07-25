/* eslint-disable no-console */
import { EventEmitter } from "events";
import WebSocket from "ws";
import fetch from "cross-fetch";
import { safeJsonParse, safeJsonStringify } from "@walletconnect/safe-json";
import {
  formatJsonRpcError,
  IJsonRpcConnection,
  JsonRpcPayload,
  isHttpUrl,
  parseConnectionError,
} from "@walletconnect/jsonrpc-utils";
import { toString } from "uint8arrays";
import { randomBytes } from "@stablelib/random";

const DEFAULT_HTTP_HEADERS = {
  Accept: "application/json",
  "Content-Type": "application/json",
};

const DEFAULT_HTTP_METHOD = "POST";

const DEFAULT_FETCH_OPTS = {
  headers: DEFAULT_HTTP_HEADERS,
  method: DEFAULT_HTTP_METHOD,
};

const BASE16 = "base16";

const separator = ":::::";

// Source: https://nodejs.org/api/events.html#emittersetmaxlistenersn
const EVENT_EMITTER_MAX_LISTENERS_DEFAULT = 10;

// TODO, this is hardcoded from one particular instance of a Nym client
const serviceProviderDefaultAddress = "EwvY4QwFXs1n6MkpiKKH9WHgntnd9BPqmHNrKRfX3ufM.J9c8X9es2Z86hvS8CpsZKYTXkjQsRnmZEc3wbQNTBv7q@2xU4CBE6QiiYt6EyBXSALwxkNvM7gqJfjHXaMkjiFmYW";


export class NymHttpConnection implements IJsonRpcConnection {
  public events = new EventEmitter();

  private isAvailable = false;

  private registering = false;

  private sharedMixnetWebsocketConnection: WebSocket | any;
  private ourAddress: string | undefined;

  constructor(public url: string, public disableProviderPing = false, sharedMixnetWebsocketConnection: WebSocket) {
    console.log("NEW NYM HTTP for " + url + " with disableping = " + disableProviderPing);
    if (!isHttpUrl(url)) {
      throw new Error(`Provided URL is not compatible with HTTP connection: ${url}`);
    }
    this.url = url;
    this.disableProviderPing = disableProviderPing;
    this.sharedMixnetWebsocketConnection = sharedMixnetWebsocketConnection;
    this.sendSelfAddressRequest();
  }

  get connected(): boolean {
    return this.isAvailable;
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
    if (!this.isAvailable) {
      throw new Error("Connection already closed");
    }
    this.onClose();
  }

  public async send(payload: JsonRpcPayload, context?: any): Promise<void> {
    console.log("NYM HTTP send this payload: " + payload);
    if (!this.isAvailable) {
      await this.register();
    }
    try {
      const body = safeJsonStringify(payload);
      const resDebug = await fetch(this.url, { ...DEFAULT_FETCH_OPTS, body });
      console.log(this.url);
      console.log(body);
      console.log(resDebug);

      const res = await this.nymFetch(safeJsonStringify(payload));
      const data = await res.json();
      console.log("From NYMFETCH:");
      console.log(res);
      console.log(data);
      this.onPayload({ data });
    } catch (e) {
      this.onError(payload.id, e as any);
    }
  }

  // ---------- Private ----------------------------------------------- //

  private async nymFetch(payload: string): Promise<Response> {
    if (typeof this.sharedMixnetWebsocketConnection === "undefined") {
      throw new Error("Shared mixnet connection for all http connection is undefined");
    }

    const recipient = serviceProviderDefaultAddress;
    const SURBsGiven = 5;

    const UID = this.generateRandomBytes32();

    // TODO this is a security flaw waiting to happen right? make a url with ::::: and you break the system. Even a payload with ::::: could become dangerous?
    const body = this.url + separator + payload + separator + UID;
    /*const res = await fetch(this.url, { ...DEFAULT_FETCH_OPTS, body });

*
const data = await res.json();
    this.onPayload({ data });*/

    const message = {
      type: "sendAnonymous",
      message: safeJsonStringify(body),
      recipient: recipient,
      replySurbs: SURBsGiven,
    };

    // TODO Doesn't that becomes a state explosion of listeners? probably... Should try to remove the listener after the UID is validated?
    this.sharedMixnetWebsocketConnection.onmessage = (e: any) => {
      this.onMixnetPayload(e, UID);
    };

    // Send our message object out via our websocket connection.
    this.sharedMixnetWebsocketConnection.send(safeJsonStringify(message));

    return new Promise(( resolve, reject ) => {
      this.once("mixnetPayload", purePayload => {
        resolve(purePayload);
      });
    });
  }

  private generateRandomBytes32(): string {
    const random = randomBytes(32);
    return toString(random, BASE16);
  }

  private async register(url = this.url): Promise<void> {
    console.log("NYM HTTP REGISTER");
    if (typeof this.sharedMixnetWebsocketConnection === "undefined") {
      throw new Error("Shared mixnet connection for all http connection is undefined");
    }
    if (!isHttpUrl(url)) {
      throw new Error(`Provided URL is not compatible with HTTP connection: ${url}`);
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
          if (typeof this.isAvailable === "undefined") {
            return reject(new Error("HTTP connection is missing or invalid"));
          }
          resolve();
        });
      });
    }
    this.url = url;
    this.registering = true;

    this.url = url;
    this.registering = true;

    try {
      if (!this.disableProviderPing) {
        const body = safeJsonStringify({ id: 1, jsonrpc: "2.0", method: "test", params: [] });
        await this.nymFetch(body);
        // await fetch(url, { ...DEFAULT_FETCH_OPTS, body });
      }
      this.onOpen();
    } catch (e) {
      const error = this.parseError(e as any);
      this.events.emit("register_error", error);
      this.onClose();
      throw error;
    }
  }


  private onOpen() {
    this.isAvailable = true;
    this.registering = false;
    this.events.emit("open");
  }

  private onClose() {
    this.isAvailable = false;
    this.registering = false;
    this.events.emit("close");
  }

  // unwrap and emit a new type of event to trigger nymFetch, so that it resolves (and potentially call onPayload from nymFetch)
  private onMixnetPayload(mixnetPayload, UID: string) {
    try {
      // console.log("Received from mixnet: " + e.data); // This can be very useful for debugging, not great for logging though
      const response = safeJsonParse(mixnetPayload.data);
      if (response.type == "error") {
        console.log("mixnet responded with error: ");
        console.log(response.message);
        // this.onReceivedError(0, response.message);
      } else if (response.type == "selfAddress") {
        this.ourAddress = response.address;
        console.log("Our address is:  " + this.ourAddress);
      } else if (response.type == "received") {
        const payload: string = response.message;
        const uidMessage = payload.split(separator);
        if (UID === uidMessage[0]) {
          const parsedPayload = safeJsonParse(uidMessage[1]);
          const purePayload = parsedPayload as Response; // TODO
          this.events.emit("mixnetPayload", purePayload);
        }
      }
    } catch (err) {
      console.log("\x1b[91mclient onMixnetPayload error: " + err + " , happened with http Payload: " + mixnetPayload.data + "\x1b[0m"); // TODO this.onError?
    }
  }

  private onPayload(e: { data: any }) {
    if (typeof e.data === "undefined") return;
    const payload: JsonRpcPayload = typeof e.data === "string" ? safeJsonParse(e.data) : e.data;
    this.events.emit("payload", payload);
  }

  private onError(id: number, e: Error) {
    const error = this.parseError(e);
    const message = error.message || error.toString();
    const payload = formatJsonRpcError(id, message);
    this.events.emit("payload", payload);
  }

  private parseError(e: Error, url = this.url) {
    return parseConnectionError(e, url, "HTTP");
  }

  private resetMaxListeners() {
    if (this.events.getMaxListeners() > EVENT_EMITTER_MAX_LISTENERS_DEFAULT) {
      this.events.setMaxListeners(EVENT_EMITTER_MAX_LISTENERS_DEFAULT);
    }
  }


  // ==========================================NYM CLIENT FUNCS=====================

  // Send a message to the mixnet client, asking what our own address is.
  private sendSelfAddressRequest() {
    const selfAddress = {
      type: "selfAddress",
    };
    this.sharedMixnetWebsocketConnection.send(safeJsonStringify(selfAddress));
  }

}

export default NymHttpConnection;
