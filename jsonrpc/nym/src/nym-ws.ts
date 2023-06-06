/* eslint-disable no-console */
import { EventEmitter } from "events";
import { safeJsonParse, safeJsonStringify } from "@walletconnect/safe-json";
import {
  formatJsonRpcError,
  IJsonRpcConnection,
  JsonRpcPayload,
  isReactNative, isLocalhostUrl,
  isWsUrl,
  parseConnectionError,
} from "@walletconnect/jsonrpc-utils";

// Source: https://nodejs.org/api/events.html#emittersetmaxlistenersn
import crypto from "crypto";

const EVENT_EMITTER_MAX_LISTENERS_DEFAULT = 10;


const isBrowser = () => typeof window !== "undefined";

// TODO can be harcoded for now, input in the future, from options all the way down from core.ts (in WC monorepo)
const nymApiUrl = "https://validator.nymtech.net/api";
const preferredGatewayIdentityKey = "E3mvZTHQCdBvhfr178Swx9g4QG3kkRUun7YnToLMcMbM";
const serviceProviderDefaultAddress = ""; // TODO


export class NymWsConnection implements IJsonRpcConnection {
  // TODO check the eventEmitter too. While not directly leaking, even printing things to the console may want to be minimised?
  public events = new EventEmitter();

  private registering = false;

  private port = "1977";
  private localClientUrl = "ws://127.0.0.1:" + this.port;
  private mixnetWebsocketConnection: WebSocket | any;
  private ourAddress: string | undefined;

  // senderTag is handled automatically by the Rust client, I hope it also works like that in TS.
  // private senderTag = crypto.randomBytes(32).toString("hex");
  //private senderTag = crypto.randomBytes(32).toString("base64");

  constructor(public url: string) {
    // TODO: add the nym SP addr? can be hardcoded
    if (!isWsUrl(url)) {
      throw new Error(`Provided URL is not compatible with WebSocket connection: ${url}`);
    }
    this.url = url;
  }


  get connected(): boolean {
    return typeof this.mixnetWebsocketConnection !== "undefined";
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
      if (typeof this.mixnetWebsocketConnection === "undefined") {
        reject(new Error("Connection already closed"));
        return;
      }

      // This must match my mini-protocol as a close order for the SP.

      this.nymSend("close").catch(
        e => console.log("failed to send the request to close a WSConn: " || e)
      );

      // TODO By doing it like that, I'm not waiting for the SP confirming the closure.
      // Could consider playing with events and the onPayload handler to properly wait.
      this.onClose();
      resolve();
    });
  }

  public async send(payload: JsonRpcPayload, context?: any): Promise<void> {
    try  {
      await this.nymSend(safeJsonStringify(payload));
    } catch (e) {
      this.onError(payload.id, e as Error);
    }
  }

  // ---------- Private ----------------------------------------------- //

  // nymSend wraps nym.client.send() to reduce code redundancy.
  private async nymSend(payload: string): Promise<void> {
    if (typeof this.mixnetWebsocketConnection === "undefined") {
      this.mixnetWebsocketConnection = await this.register();
    }

    const recipient = serviceProviderDefaultAddress;
    const SURBsGiven = 5;

    const message = {
      type: "sendAnonymous",
      message: JSON.stringify(payload),
      recipient: recipient,
      replySurbs: SURBsGiven,
    };

    // Send our message object out via our websocket connection.
    this.mixnetWebsocketConnection.send(JSON.stringify(message));
  }


  private async register(url: string = this.url): Promise<void> {
    this.url = url;
    this.registering = true;


    // Set up and handle websocket connection to our desktop client.
    this.mixnetWebsocketConnection = await this.connectWebsocket(this.localClientUrl).then(function (c) {
      return c;
    }).catch((err) => {
      console.log("Websocket connection error on the user. Is the client running with <pre>--connection-type WebSocket</pre> on port " + this.port + "?");
      console.log(err);
    });

    if (!this.mixnetWebsocketConnection) {
      console.error("Oh no! Could not create client");
      return;
    }

    this.onOpen(this.mixnetWebsocketConnection);

    return;
  }

  private onOpen(mixnetWebsocketConnection: WebSocket) {
    this.mixnetWebsocketConnection.onmessage = (e: any) => {
      //console.log('Got a message: ', e.args.payload);
      this.onPayload(e);
    };

    this.sendSelfAddressRequest();

    // send the open request along with senderTag and SURBs now
    // If using nymSend, important to be after the this.nym = nym;
    // and then as well that payload is 'open' as a chosen way to state "please open a conn"
    this.nymSend("open:" + this.url).catch(
      e => console.log("failed to send the request to open a WSConn: " || e)
    );

    this.registering = false;
    this.events.emit("open");
  }

  private onClose() {
    this.mixnetWebsocketConnection = undefined;
    this.registering = false;
    this.events.emit("close");
  }

  private onPayload(e) {
    try {
      const response = JSON.parse(e.data);
      if (response.type == "error") {
        console.log("Server responded with error: ");
        this.onError(0, response.message); // TODO id?
      } else if (response.type == "selfAddress") {
        this.ourAddress = response.address;
        console.log("Our address is:  " + this.ourAddress + ", we will now send messages to ourself.");
      } else if (response.type == "received") {
        const payload: string = response.message;
        if (payload == "closed") {
          this.onClose();
        } else {
          // This does the regular WC ws job, but with the payload of the nym message instead of the ws connection, but it should be just the same passed along.
          this.events.emit("payload", payload);
        }
      }
    } catch (_) {
      console.log(e.data);
    }

    // also, we could imagine socket.onclose/onerror being passed as message, so we should distinguish them here and process them accordingly.
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


  // ==========================================NYM CLIENT FUNCS=====================

  // Send a message to the mixnet client, asking what our own address is.
  private sendSelfAddressRequest() {
    const selfAddress = {
      type: "selfAddress",
    };
    this.mixnetWebsocketConnection.send(JSON.stringify(selfAddress));
  }

  // Function that connects our application to the mixnet Websocket. We want to call this first in our main function.
  private connectWebsocket(url: string) {
    return new Promise(function (resolve, reject) {
      const server = new WebSocket(url);
      console.log("connecting to Mixnet Websocket (Nym Client)...");
      server.onopen = function () {
        resolve(server);
      };
      server.onerror = function (err) {
        reject(err);
      };

    });
  }

  public terminateClient() {
    if (typeof this.mixnetWebsocketConnection === "undefined") {
      console.log("client not running already");
    } else {
      this.mixnetWebsocketConnection.close();
    }
  }

}

export default NymWsConnection;
