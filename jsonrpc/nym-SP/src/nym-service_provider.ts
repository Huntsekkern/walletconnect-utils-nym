/* eslint-disable no-console */
import WebSocket, { MessageEvent } from "ws";
import fetch from "cross-fetch";
import { safeJsonParse, safeJsonStringify } from "@walletconnect/safe-json";
import {
  formatJsonRpcError,
  JsonRpcPayload,
  isReactNative,
  isWsUrl,
  isLocalhostUrl,
  isJsonRpcPayload,
} from "@walletconnect/jsonrpc-utils";

// Source: https://nodejs.org/api/events.html#emittersetmaxlistenersn
const EVENT_EMITTER_MAX_LISTENERS_DEFAULT = 10;


// TODO
const defaultRelayServerUrl = "wss://staging.relay.walletconnect.com";

const DEFAULT_HTTP_HEADERS = {
  Accept: "application/json",
  "Content-Type": "application/json",
};

const DEFAULT_HTTP_METHOD = "POST";

const DEFAULT_FETCH_OPTS = {
  headers: DEFAULT_HTTP_HEADERS,
  method: DEFAULT_HTTP_METHOD,
};

const separator = ":::::";

// TODO nearly everything but setup can be private here as they are mostly triggered by incoming messages
// But for unit-testing I made some part public, take into account and could reswitch to private later.
export class NymServiceProvider {
  private port = "1978";
  private localClientUrl = "ws://127.0.0.1:" + this.port;
  private mixnetWebsocketConnection: WebSocket | undefined;
  private ourAddress: string | undefined;

  public tagToWSConn: Map<string, WebSocket> = new Map();

  // Always call setup after new NymWsServiceProvider(); ! Necessary because the constructor cannot wait.
  public async setup() {
    // Set up and handle websocket connection to our desktop client.
    this.mixnetWebsocketConnection = await this.connectToMixnetWebsocket(this.localClientUrl).then(function (c) {
      return c;
    }).catch((err) => {
      console.log("Websocket connection error on the service-provider. Is the client running with <pre>--connection-type WebSocket</pre> on port " + this.port + "?");
      console.log(err.error);
    });

    this.mixnetWebsocketConnection.onmessage = (e: any) => {
      this.handleAllMixnetMessage(e);
    };

    this.sendSelfAddressRequest();
  }


  // Handle any messages that come back down the mixnet-facing client websocket.
  private async handleAllMixnetMessage(responseMessageEvent: MessageEvent) {
    try {
      const message = safeJsonParse(responseMessageEvent.data.toString());
      if (message.type == "error") {
        console.log("\x1b[91mAn error occured: " + message.message + "\x1b[0m");
      } else if (message.type == "selfAddress") {
        this.ourAddress = message.address;
        console.log("\x1b[94mSP address is: " + this.ourAddress + "\x1b[0m");
      } else if (message.type == "received") {
        // Those are the messages received from the mixnet, i.e., from the wallets and dapps.
        console.log("\x1b[92mReceived from a client: " + message.message + "\x1b[0m");
        await this.handleReceivedMixnetMessage(message);
      }
    } catch (err) {
      console.log("something went wrong in handleAllMixnetMessage: " + err);
    }
  }

  // handleReceivedMixnetMessage process the messages from mixnet users (wallet/dapp)
  // The three main actions are open a connection, close a connection or forward an RPC on an existing connection.
  private async handleReceivedMixnetMessage(response: any) {
    const senderTag = response.senderTag;
    const message = response.message;

    if (message.startsWith("http")) {
      const urlMessageUid = message.split(separator);
      await this.proxyFetch(senderTag, urlMessageUid[0], urlMessageUid[1], urlMessageUid[2]);
    } else if (message.startsWith("open")) {
      // extract the url from the payload which pattern should be open:url
      const url = message.substring(5);
      await this.openWStoRelay(url, senderTag);
    } else if (message == "close") {
      console.log("SP received close request from client");
      await this.closeWStoRelay(senderTag);
    } else { // Then the message is a JSONRPC to be passed to the relay server
      const messageInJson = safeJsonParse(message);
      if (isJsonRpcPayload(messageInJson)) {
        await this.forwardRPCtoRelay(senderTag, messageInJson);
      } else {
        console.log("payload is not jsonrpc: " + messageInJson);
      }
    }
  }

  public async proxyFetch(senderTag: string, url: string, body: string, UID: string): Promise<void> {
    const res = await fetch(url, { ...DEFAULT_FETCH_OPTS, body });
    const data = await res.json(); // could to text() and hopefully remove the safeJsonStringify, but safer that way.
    console.log("data:");
    console.log(data);
    this.sendMessageToMixnet(safeJsonStringify(UID + separator + safeJsonStringify(data)), senderTag);
  }

// openWStoRelay opens a new WebSocket connection to a specified url for a given senderTag.
  public async openWStoRelay(url: string, senderTag: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!isWsUrl(url)) {
        // TODO error, either choose a relay server url or transmit error to user?
        const err = new Error("The url given is not a valid WS url");
        this.onError(0, err, senderTag);
        reject(err);
      }

      if (this.tagToWSConn.has(senderTag)) {
        // The socket already exists. A more advanced version could let the user open connections to several relays...
        // But for now, it doesn't seem necessary, so let's just tell the user: yes, the connection is open.
        // By doing that, I also don't allow the user to change relays without closing the connection first. It's fine.
          console.log("socket already existing, no need to open");
        this.sendMessageToMixnet("opened", senderTag);
          return resolve(this.tagToWSConn.get(senderTag));
      }

      const opts = !isReactNative() ? { rejectUnauthorized: !isLocalhostUrl(url) } : undefined;
      const socket: WebSocket = new WebSocket(url, [], opts);
      (socket as any).on("error", (errorEvent: any) => {
        const err = new Error("Couldn't open a WS to relay: " + errorEvent.toString());
        this.onError(0, err, senderTag);
        // This rejects the error event from the WS instead of the self-build error in order to pass my tests.
        // No big change, except in what is logged by the SP.
        reject(errorEvent);
      });
      socket.onopen = () => {
        this.onOpen(socket, senderTag);
        resolve(socket);
      };
    });
  }

// closeWStoRelay closes a WebSocket connection identified by the given senderTag.
  public async closeWStoRelay(senderTag: string): Promise<void> {
    console.log("closeWStoRelay");
    return new Promise<void>((resolve, reject) => {
      const socket: WebSocket = this.tagToWSConn.get(senderTag);

      if (typeof socket === "undefined") {
        // Tell the user that the connection is closed to allow it to shutdown.
        // In fact the connection was already closed, but the user do not need the distinction.
          // TODO this is a messy situation: it is tempting to tell the user "closed" to take care of cases where a message may get dropped, etc. But since the user reacts automatically to "closed" message, it can also causes confusion. Especially within tests which open and shutdown multiple connections
       // this.sendMessageToMixnet("closed", senderTag);
        reject(new Error("Connection already closed"));
        return;
      }

      socket.onclose = () => {
          this.onClose(socket, senderTag);
          resolve();
      };

      socket.close();
    });
  }


// forwardRPCtoRelay sends the RPC payload of a mixnet-received packet through the matching WS connection with a relay-server
  public async forwardRPCtoRelay(senderTag: string, payload: any): Promise<void> {
    const socket = this.tagToWSConn.get(senderTag);

    if (typeof socket === "undefined") {
      // do I return an error to the client or do I open a new WS connection to the relay server?
      // I'd say the second option. But I'm lacking the url now...
      await this.openWStoRelay(defaultRelayServerUrl, senderTag);
    }

    return new Promise<void>((resolve, reject) => {
      try {
        socket.send(safeJsonStringify(payload));
      } catch (e) {
        const err = new Error("Couldn't forward RPC with err: " + e);
        this.onError(payload.id, err as Error, senderTag);
        reject(e);
      }

      resolve();
    });
  }

// onOpen is called when a new WS to a relay-server is created on request from a mixnet user.
  private onOpen(socket: WebSocket, senderTag: string) {
      console.log("on open");
    this.tagToWSConn.set(senderTag, socket);
    socket.onmessage = (event: MessageEvent) => this.onPayload(senderTag, event);
    socket.onclose = () => this.onClose(socket, senderTag);
    this.sendMessageToMixnet("opened", senderTag);
  }

// onClose is called when a mixnet user request to closes its WS connection
// OR when the relay-server sends a close message to the WS.
  private onClose(socket: WebSocket, senderTag: string) {
    console.log("Closing the Relay WS connection for " + senderTag);
    this.sendMessageToMixnet("closed", senderTag);
    this.tagToWSConn.delete(senderTag);
  }

// onPayload is called when a relay-server sends a payload to an existing WS.
// The service provider forwards the received payload to the matching mixnet user.
  private onPayload(senderTag: string, m: { data: any }) {
    if (typeof m.data === "undefined") return;
    const payload: JsonRpcPayload = typeof m.data === "string" ? safeJsonParse(m.data) : m.data;
    console.log("Payload from relay: " + m.data);
    this.sendMessageToMixnet(safeJsonStringify(payload), senderTag);
  }

  private onError(id: number, error: Error, senderTag: string) {
    const message: string = error.toString();
    const payload = formatJsonRpcError(id, message);
    this.sendMessageToMixnet(safeJsonStringify(payload), senderTag);
  }

// sendMessageToMixnet sends a message to a mixnet user (wallet/dapp) identified by its sender_tag
// it relies on a Nym send function, which should be explored better to ensure correct usage.
  private sendMessageToMixnet(messageContent: string, senderTag: string) {
    const message = {
      type: "reply",
      message: messageContent,
      senderTag: senderTag,
    };
    // as I'm using the senderTag, the matching SURBs automatically retrieved, this also removes all need to keep track of the SURBs!

    console.log("\x1b[96mSent to a client: " + JSON.stringify(message) + "\x1b[0m");
    // Send our message object out via our websocket connection.
    // might want to try to switch to safeJsonStringify, but it causes issues... I think when sending back errors?
    this.mixnetWebsocketConnection.send(JSON.stringify(message));
  }

// Send a message to the mixnet client, asking what our own address is.
  private sendSelfAddressRequest() {
    const selfAddress = {
      type: "selfAddress",
    };
    this.mixnetWebsocketConnection.send(safeJsonStringify(selfAddress));
  }

// connectToMixnetWebsocket connects our application to the mixnet Websocket. We want to call this first when setting up.
  private connectToMixnetWebsocket(url: string): Promise<WebSocket> {
    return new Promise(function (resolve, reject) {
      const server = new WebSocket(url);
      console.log("SP connecting to Mixnet Websocket (Nym Client)...");
      server.onopen = function () {
        resolve(server);
      };
      server.onerror = function (err) {
        reject(err);
      };
    });
  }

  public terminateServiceProvider() {
    if (typeof this.mixnetWebsocketConnection === "undefined") {
      console.log("serviceProvider not running already");
    } else {
      this.tagToWSConn.forEach((WSConn, senderTag) => {
        WSConn.close();
        console.log(senderTag + " conn closed");
      });
      this.mixnetWebsocketConnection.close();
    }
  }
}



export default NymServiceProvider;
