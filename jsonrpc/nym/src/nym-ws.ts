/* eslint-disable no-console */
import WebSocket from "ws";
import { EventEmitter } from "events";
import { safeJsonParse, safeJsonStringify } from "@walletconnect/safe-json";
import {
  formatJsonRpcError,
  IJsonRpcConnection,
  JsonRpcPayload,
  isWsUrl,
  parseConnectionError,
} from "@walletconnect/jsonrpc-utils";
import { truncateQuery, resolveWebSocketImplementation, hasBuiltInWebSocket } from "./utils";

// Source: https://nodejs.org/api/events.html#emittersetmaxlistenersn
const EVENT_EMITTER_MAX_LISTENERS_DEFAULT = 10;


const isBrowser = () => typeof window !== "undefined";
// can be harcoded for now, input in the future, from options all the way down from core.ts (in WC monorepo)
// Also this was only useful for the Nym SDK, not when running the Nym Client.
const nymApiUrl = "https://validator.nymtech.net/api";
const preferredGatewayIdentityKey = "E3mvZTHQCdBvhfr178Swx9g4QG3kkRUun7YnToLMcMbM";

// TODO, this is hardcoded from one particular instance of a Nym client
const serviceProviderDefaultAddress = "EwvY4QwFXs1n6MkpiKKH9WHgntnd9BPqmHNrKRfX3ufM.J9c8X9es2Z86hvS8CpsZKYTXkjQsRnmZEc3wbQNTBv7q@2xU4CBE6QiiYt6EyBXSALwxkNvM7gqJfjHXaMkjiFmYW";


export class NymWsConnection implements IJsonRpcConnection {
  // TODO check the eventEmitter too. While not directly leaking, even printing things to the console may want to be minimised?
  public events = new EventEmitter();

  private registering = false;

  private connectedToRelay = false;

  // connectedToMixnet is not used, as the (typeof this.mixnetWebsocketConnection !== "undefined") check is more direct

  private port = "1977";
  private localClientUrl = "ws://127.0.0.1:" + this.port;
  private mixnetWebsocketConnection: WebSocket | any;
  private ourAddress: string | undefined;

  constructor(public url: string, localClientPort = "1977") {
    // TODO: add the nym SP addr? can be hardcoded
    if (!isWsUrl(url)) {
      throw new Error(`Provided URL is not compatible with WebSocket connection: ${url}`);
    }
    this.url = url;
    this.port = localClientPort;
    this.localClientUrl = "ws://127.0.0.1:" + this.port;
  }


  get connected(): boolean {
    return this.connectedToRelay;
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

  // close tells the SP to close the connection to the relay server.
  // The user then expects the confirmation from the SP to fully disconnect from the local Nym client
  public async close(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // Mixnet already shut down
      if (typeof this.mixnetWebsocketConnection === "undefined") {
        reject(new Error("Connection already closed"));
        return;
      }

      // Relay shut down but not the mixnet, then finish the local shutting down.
      if (!this.connectedToRelay) {
        this.onRelayClose();
        resolve();
        return;
      }

      // Else this match my mini-protocol as a close order for the SP, then waits for the confirmation to resolve.
      this.nymSend("close").then(() => {
        // By calling this.onRelayClose() right here, I would not be waiting for the SP confirming the closure.
        // Instead, I now properly wait for the SP answer to close the socket.
        // This comes with advantage and disadvantages I guess? Make sure that incoming messages are waited for.
        // But also might fail to close if the reply is lost.
        this.events.once("close", () => {
          resolve();
        });
      }).catch(e => {
        console.log("failed to send the request to close a WSConn: " || e);
        reject(e);
      });
    });
  }

  public async send(payload: JsonRpcPayload, context?: any): Promise<void> {
    try  {
      await this.nymSend(safeJsonStringify(payload));
    } catch (e) {
      this.onSendError(payload.id, e as Error);
    }
  }

  // ---------- Private ----------------------------------------------- //

  // nymSend wraps this.mixnetWebsocketConnection.send() to reduce code redundancy while keeping the public send clean.
  private async nymSend(payload: string): Promise<void> {
    // This must NOT block if the relay connection is not established, as it may send open requests as well.
    if (typeof this.mixnetWebsocketConnection === "undefined") {
      await this.register();
    }

    const recipient = serviceProviderDefaultAddress;
    const SURBsGiven = 5;

    const message = {
      type: "sendAnonymous",
      message: safeJsonStringify(payload),
      recipient: recipient,
      replySurbs: SURBsGiven,
    };

    // Send our message object out via our websocket connection.
    this.mixnetWebsocketConnection.send(safeJsonStringify(message));
  }


  // register connects to the local Nym client, then calls requestOpenWSConn
  private async register(url: string = this.url): Promise<void> {
    if (!isWsUrl(url)) {
      throw new Error(`Provided URL is not compatible with WebSocket connection: ${url}`);
    }

    // Maybe this doesn't fully follow the default WalletConnect implementation, as it doesn't allow to connect to several relays simultaneously, but for now, this shortcut is fine.
    if (this.connectedToRelay) {
      return;
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
          if (typeof this.mixnetWebsocketConnection === "undefined" || !this.connectedToRelay) {
            return reject(new Error("WebSocket connection is missing or invalid"));
          }
          resolve();
        });
      });
    }

    this.url = url;
    this.registering = true;

    // Might be the case that only the relay connection is down.
    if (typeof this.mixnetWebsocketConnection === "undefined") {
      await this.connectToMixnet();
    }

    return await this.requestOpenWSConn(this.url);
  }

  private async connectToMixnet(): Promise<WebSocket> {
    // Set up and handle websocket connection to our desktop client.
    this.mixnetWebsocketConnection = await this.connectWebsocket(this.localClientUrl).then(function (c) {
      return c;
    }).catch((err) => {
      console.log("Websocket connection error on the user. Is the client running with <pre>--connection-type WebSocket</pre> on port " + this.port + "?");
      console.log(err);
      return new Promise((resolve, reject) => {
        reject(this.emitRegisterError(err.error));
      });
    });

    if (!this.mixnetWebsocketConnection) {
      const err = new Error("Oh no! Could not create client");
      console.error(err);
      return new Promise((resolve, reject) => {
        reject(this.emitRegisterError(err));
      });
    }

    this.mixnetWebsocketConnection.onmessage = (e: any) => {
      this.onPayload(e);
    };

    this.sendSelfAddressRequest();

    return new Promise((resolve) => {
      resolve(this.mixnetWebsocketConnection);
    });
  }

  // requestOpenWSConn asks the SP to open a connection to the relay
  private async requestOpenWSConn(url: string = this.url): Promise<void> {
    // send the open request along with senderTag and SURBs now
    // If using nymSend, important to be after the this.nym = nym;
    // and then as well that payload is 'open' as a chosen way to state "please open a conn"
    return new Promise<void>((resolve, reject) => {
      this.nymSend("open:" + url).then(() => {
        this.events.once("open", () => {
          // TODO should I check that it's the proper answer? Maybe by checking the url? But I don't think that checking the url is enough..
          resolve();
        });
        // TODO ok, I think I got the issue, this is triggering also on future Errors, but the promise was already resolved, so I get an unhandled rejection, since nothing is awaiting for the rejection anymore...
        // And conversely, an incoming payload from another existing WSConn would trigger the event, yet not enter the if statement.
        // I guess the solution is to make a unique type of event??
        // TODO now, this is also not taking into account send error through the WS to the nym client, because I had to split the error types to match the event flow of vanilla-WC
        // I have never got one yet, and vanilla-ws also dissociate send error from register error, well, I can't achieve perfection here I guess.
        this.events.once("communication_error", payload => {
          // TODO might want to make startsWith emcompass all "Error:", but for now, that's the one I've been getting.
          if (typeof payload.error != "undefined" && typeof payload.error.message != "undefined" && payload.error.message.startsWith("Error: Couldn't open a WS to relay")) {
            const err = new Error(payload.error.message.substring(7));
            //const err = new Error(payload.error.message);
            console.log("\x1b[91mFailed to open a WS to relay\x1b[0m");
            reject(this.emitRegisterError(err));
          } else {
            console.log("\x1b[91mThis payload was tagged as an error, but does not seem to conform what the software expect right now!\x1b[0m");
            console.log(payload);
          }
        });
      }).catch(e => {
        console.log("failed to send the request to open a WSConn: " || e);
        reject(this.emitRegisterError(e));
      });
    });
  }

  // onRelayOpen processes after receiving the confirmation that the SP opened a connection to the relay
  private onRelayOpen() {
    this.connectedToRelay = true;
    this.registering = false;
    this.events.emit("open");
  }

  // onRelayClose kills the connection to the local Nym Client
  private onRelayClose() {
    this.mixnetWebsocketConnection.close();
    this.mixnetWebsocketConnection = undefined;
    this.registering = false;
    this.connectedToRelay = false;
    this.events.emit("close");
  }

  // closeLocallyOnError kills the connection to the local Nym Client
  private closeLocallyOnError() {
    if (typeof this.mixnetWebsocketConnection !== "undefined") {
      this.mixnetWebsocketConnection.close();
      this.mixnetWebsocketConnection = undefined;
    }
    this.registering = false;
    this.connectedToRelay = false;
  }

  private onPayload(e) {
    try {
      // console.log("Received from mixnet: " + e.data); // This can be very useful for debugging, not great for logging though
      const response = safeJsonParse(e.data);
      if (response.type == "error") {
        console.log("mixnet responded with error: ");
        this.onReceivedError(0, response.message); // TODO id?, and overall I expect it to bug out.
      } else if (response.type == "selfAddress") {
        this.ourAddress = response.address;
        console.log("Our address is:  " + this.ourAddress);
      } else if (response.type == "received") {
        const payload: string = response.message;
        const parsedPayload = safeJsonParse(payload);
        if (payload === "closed") {
          console.log("WS connection between SP and relay is closed");
          this.onRelayClose();
        } else if (payload === "opened") {
          console.log("WS connection between SP and relay is opened");
          this.onRelayOpen();
        } else if (parsedPayload.hasOwnProperty("error")) {
          console.log("SP responded with error: ");
          this.onReceivedError(parsedPayload.id, parsedPayload.error);
        } else {
          // This does the regular WC ws job, but with the payload of the nym message instead of the ws connection, but it should be just the same passed along.
          // console.log("Client received: " + payload);
          // console.log("\x1b[91mEmit payload: " + "\x1b[0m");
          // console.log(parsedPayload);
          this.events.emit("payload", parsedPayload);
        }
      }
    } catch (err) {
      console.log("\x1b[91mclient onPayload error: " + err + " , happened withPayload: " + e.data + "\x1b[0m"); // TODO this.onError?
    }
  }

  private onSendError(id: number, e: Error) {
    const error = this.parseError(e);
    const message = error.message || error.toString();
    const payload = formatJsonRpcError(id, message);
    this.closeLocallyOnError();
    this.events.emit("error", payload);
  }

  private onReceivedError(id: number, e: Error) {
    console.log(e);
    const message = e.message;
    const payload = formatJsonRpcError(id, message);
    this.closeLocallyOnError();
    // communication_error is named as such to not clash with the WC event error
    this.events.emit("communication_error", payload);
  }

  private parseError(e: Error, url = this.url) {
    return parseConnectionError(e, truncateQuery(url), "WS");
  }

  private resetMaxListeners() {
    if (this.events.getMaxListeners() > EVENT_EMITTER_MAX_LISTENERS_DEFAULT) {
      this.events.setMaxListeners(EVENT_EMITTER_MAX_LISTENERS_DEFAULT);
    }
  }

  private emitRegisterError(errorEvent: Error) {
    const error = this.parseError(
        new Error(
            errorEvent?.message || `WebSocket connection failed for host: ${truncateQuery(this.url)}`,
        ),
    );
    this.closeLocallyOnError();
    this.events.emit("register_error", error);
    return error;
  }


  // ==========================================NYM CLIENT FUNCS=====================

  // Send a message to the mixnet client, asking what our own address is.
  private sendSelfAddressRequest() {
    const selfAddress = {
      type: "selfAddress",
    };
    this.mixnetWebsocketConnection.send(safeJsonStringify(selfAddress));
  }

  // Function that connects our application to the mixnet Websocket. We want to call this when registering.
  private connectWebsocket(url: string): Promise<void> {
    return new Promise(function (resolve, reject) {
      const server = new WebSocket(url);
      console.log("user connecting to Mixnet Websocket (Nym Client)...");
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
      console.log("terminateClient not executed: client not running already");
    } else {
      this.nymSend("close");
      this.onRelayClose();
    }
  }
}

export default NymWsConnection;
