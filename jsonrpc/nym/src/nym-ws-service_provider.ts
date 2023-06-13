/* eslint-disable no-console */
import WebSocket, { MessageEvent } from "ws";
import BiMap from "bidirectional-map";
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

// TODO nearly everything can be private here as they are mostly triggered by incoming messages
// But for unit-testing I made some part public, take into account and could reswitch to private later.
export class NymWsServiceProvider {
  private port = "1978";
  private localClientUrl = "ws://127.0.0.1:" + this.port;
  private mixnetWebsocketConnection: WebSocket | undefined;
  private ourAddress: string | undefined;

  // TODO not even sure I need it to be a Bidirectional Map as I'm passing senderTag as param to onClose/OnPayload.
  //private tagToWSConn: Map<string, WebSocket> = new Map();
  public tagToWSConn: BiMap = new BiMap;

  // Always call setup after new NymWsServiceProvider(); ! Necessary because the constructor cannot wait.
  public async setup() {
    // Set up and handle websocket connection to our desktop client.
    this.mixnetWebsocketConnection = await this.connectWebsocket(this.localClientUrl).then(function (c) {
      return c;
    }).catch((err) => {
      console.log("Websocket connection error on the service-provider. Is the client running with <pre>--connection-type WebSocket</pre> on port " + this.port + "?");
      console.log(err);
    });

    this.mixnetWebsocketConnection.onmessage = (e: any) => {
      this.handleResponse(e);
    };

    this.sendSelfAddressRequest();
  }


  // Handle any messages that come back down the mixnet-facing client websocket.
  private async handleResponse(responseMessageEvent: MessageEvent) {
    try {
      const message = safeJsonParse(responseMessageEvent.data.toString());
      if (message.type == "error") {
        console.log("\x1b[91mAn error occured: " + message.message + "\x1b[0m");
      } else if (message.type == "selfAddress") {
        this.ourAddress = message.address;
        console.log("\x1b[94mSP address is: " + this.ourAddress + "\x1b[0m");
      } else if (message.type == "received") {
        // Those are the messages received from the mixnet, i.e., from the wallets and dapps.
        console.log("Received from a client: " + message.message);
        await this.handleReceivedMixnetMessage(message);
      }
    } catch (err) {
      console.log("something went wrong in handleResponse: " + err);
    }
  }

  // handleReceivedMixnetMessage process the messages from mixnet users (wallet/dapp)
  // The three main actions are open a connection, close a connection or forward an RPC on an existing connection.,
  private async handleReceivedMixnetMessage(response: any) {
    const senderTag = response.senderTag;
    const message = response.message;

    if (message.startsWith("open")) {
      // extract the url from the payload which pattern should be open:url
      const url = message.substring(5);
      await this.openWS(url, senderTag);
    } else if (message == "close") {
      await this.closeWS(senderTag);
    } else { // Then the message is a JSONRPC to be passed to the relay server
      const messageInJson = safeJsonParse(message);
      if (isJsonRpcPayload(messageInJson)) {
        await this.forwardRPC(senderTag, messageInJson);
      } else {
        console.log("payload is not jsonrpc: " + messageInJson);
      }
    }
  }

// openWS opens a new WebSocket connection to a specified url for a given senderTag.
  public async openWS(url: string, senderTag: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!isWsUrl(url)) {
        // TODO error, either choose a relay server url or transmit error to user? Might or might not want to extract in the calling function
        const err = new Error("The url given is not a valid WS url");
        this.onError(0, err, senderTag);
        reject(err);
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
        this.tagToWSConn.set(senderTag, socket);
        this.onOpen(socket, senderTag);
        resolve(socket);
      };
    });
  }

// closeWS closes a WebSocket connection identified by the given senderTag.
  public async closeWS(senderTag: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket: WebSocket = this.tagToWSConn.get(senderTag);
      if (typeof socket === "undefined") {
        // Tell the user that the connection is closed to allow it to shutdown.
        // In fact the connection was already closed, but the user do not need the distinction.
        this.sendMessageToMixnet("closed", senderTag);
        reject(new Error("Connection already closed"));
        return;
      }

      socket.onclose = event => {
        this.onClose(event, socket, senderTag);
        resolve();
      };

      socket.close();
    });
  }


// forwardRPC sends the RPC payload of a mixnet-received packet through the matching WS connection with a relay-server
  public async forwardRPC(senderTag: string, payload: any): Promise<void> {
    const socket = this.tagToWSConn.get(senderTag);
    if (typeof socket === "undefined") {
      // do I return an error to the client or do I open a new WS connection to the relay server?
      // I'd say the second option. But I'm lacking the url now...
      await this.openWS(defaultRelayServerUrl, senderTag);
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
    socket.onmessage = (event: MessageEvent) => this.onPayload(senderTag, event);
    socket.onclose = event => this.onClose(event, socket, senderTag);
  }

// onClose is called when a mixnet user request to closes its WS connection
// OR when the relay-server sends a close message to the WS.
  private onClose(event: CloseEvent, socket: WebSocket, senderTag: string) {
    console.log("Closing the Relay WS connection for " + senderTag);
    this.sendMessageToMixnet("closed", senderTag);
    this.tagToWSConn.delete(senderTag);
  }

// onPayload is called when a relay-server sends a payload to an existing WS.
// The service provider forwards the received payload to the matching mixnet user.
  private onPayload(senderTag: string, e: { data: any }) {
    if (typeof e.data === "undefined") return;
    const payload: JsonRpcPayload = typeof e.data === "string" ? safeJsonParse(e.data) : e.data;
    console.log("Payload from relay: " + e.data);
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
      //message: safeJsonStringify(messageContentToSend),
      message: messageContent,
      senderTag: senderTag,
    };
    // as I'm using the senderTag, the matching SURBs automatically retrieved, this also removes all need to keep track of the SURBs!

    // Send our message object out via our websocket connection.
    // TODO might want to try to switch to safeJsonStringify, but it causes issues... I think when sending back errors?
    this.mixnetWebsocketConnection.send(JSON.stringify(message));
  }

// Send a message to the mixnet client, asking what our own address is.
  private sendSelfAddressRequest() {
    const selfAddress = {
      type: "selfAddress",
    };
    this.mixnetWebsocketConnection.send(safeJsonStringify(selfAddress));
  }

// Function that connects our application to the mixnet Websocket. We want to call this first in our main function.
  private connectWebsocket(url: string) {
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
      this.mixnetWebsocketConnection.close();
    }
  }
}



export default NymWsServiceProvider;
