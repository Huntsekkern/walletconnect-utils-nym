import WebSocket, { MessageEvent } from "ws";
import BiMap from 'bidirectional-map';
import { safeJsonParse, safeJsonStringify } from "@walletconnect/safe-json";
import {
  formatJsonRpcError, IJsonRpcConnection, parseConnectionError,
  JsonRpcPayload,
  isReactNative,
  isWsUrl,
  isLocalhostUrl,
  isJsonRpcPayload,
} from "@walletconnect/jsonrpc-utils";

// Source: https://nodejs.org/api/events.html#emittersetmaxlistenersn
const EVENT_EMITTER_MAX_LISTENERS_DEFAULT = 10;

// TODO not even sure I need it to be a Bidirectional Map as I'm passing senderTag as param to onClose/OnPayload.
//const tagToWSConn: Map<string, WebSocket> = new Map();
const tagToWSConn: BiMap = new BiMap;

let ourAddress:          string;
let mixnetWebsocketConnection: any;

// TODO
const defaultRelayServerUrl = "";

// TODO might want to do it in a class instead of a main function?

async function main() {
  const port = "1978";
  const localClientUrl = "ws://127.0.0.1:" + port;


  // Set up and handle websocket connection to our desktop client.
  mixnetWebsocketConnection = await connectWebsocket(localClientUrl).then(function (c) {
    return c;
  }).catch(function (err) {
    console.log("Websocket connection error. Is the client running with <pre>--connection-type WebSocket</pre> on port " + port + "?");
    console.log(err);
  })

  mixnetWebsocketConnection.onmessage = function (e : any) {
    handleResponse(e);
  };

  sendSelfAddressRequest();
}



// Handle any messages that come back down the mixnet-facing client websocket.
async function handleResponse(responseMessageEvent: MessageEvent) {
  try {
    let message = JSON.parse(responseMessageEvent.data.toString());
    if (message.type == "error") {
      console.log("\x1b[91mAn error occured: " + message.message + "\x1b[0m")
    } else if (message.type == "selfAddress") {
      ourAddress = message.address;
      console.log("\x1b[94mOur address is: " + ourAddress + "\x1b[0m")
    } else if (message.type == "received") {
      // Those are the messages received from the mixnet, i.e., from the wallets and dapps.
      await handleReceivedMixnetMessage(message)
    }
  } catch (_) {
    console.log('something went wrong in handleResponse')
  }
}


// handleReceivedMixnetMessage process the messages from mixnet users (wallet/dapp)
// The three main actions are open a connection, close a connection or forward an RPC on an existing connection.,
async function handleReceivedMixnetMessage(response: any) {
  // TODO not sure about the layers of JSON here, doc unclear, will have to try and look at what come through.
  let senderTag = response.senderTag;

  if (response.message.startsWith("open")) {
    // extract the url from the payload which pattern should be open:url
    const url = response.message.substring(5);
    await openWS(url, senderTag);
  } else if (response.message == "close") {
    await closeWS(senderTag)
  } else { // Then the message is a JSONRPC to be passed to the relay server
    let messageContent = JSON.parse(response.message);
    //let payload = response.payload;
    let payload = messageContent.payload;
    if (isJsonRpcPayload(payload)) {
      await forwardRPC(senderTag, payload)
    } else {
      console.log("payload is not jsonrpc: " + payload);
    }
  }


  /*console.log('\x1b[93mReceived : \x1b[0m');
  console.log('\x1b[92mName : ' + messageContent.name + '\x1b[0m');
  console.log('\x1b[92mService : ' + messageContent.service + '\x1b[0m');
  console.log('\x1b[92mComment : ' + messageContent.comment + '\x1b[0m');

  console.log('\x1b[93mSending response back to client... \x1b[0m')

  sendMessageToMixnet('nothing relevant', response.senderTag);*/
}

// openWS opens a new WebSocket connection to a specified url for a given senderTag.
async function openWS(url: string, senderTag: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (!isWsUrl(url)) {
      // error, either choose a relay server url or transmit error to user? Might or might not want to extract in the calling function
      sendMessageToMixnet("error: the url given is not a valid WS url", senderTag)
      reject(new Error("the url given is not a valid WS url"));
    }
    const opts = !isReactNative() ? { rejectUnauthorized: !isLocalhostUrl(url) } : undefined;
    const socket: WebSocket = new WebSocket(url, [], opts);
    (socket as any).on("error", (errorEvent: any) => {
      console.log(errorEvent);
    });
    socket.onopen = () => {
      tagToWSConn.set(senderTag, socket);
      onOpen(socket, senderTag);
      resolve(socket);
    };
  });
}

// closeWS closes a WebSocket connection identified by the given senderTag.
async function closeWS(senderTag: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const socket: WebSocket = tagToWSConn.get(senderTag);
    if (typeof socket === "undefined") {
      reject(new Error("Connection already closed"));
      return;
    }

    socket.onclose = () => {
      onClose(socket, senderTag);
      resolve();
    };

    socket.close();
  });
}



// forwardRPC sends the RPC payload of a mixnet-received packet through the matching WS connection with a relay-server
async function forwardRPC(senderTag: string, payload: any) {
  const socket = tagToWSConn.get(senderTag);
  if (typeof socket === "undefined") {
    // do I return an error to the client or do I open a new WS connection to the relay server?
    // I'd say the second option. But I'm lacking the url now...
    await openWS(defaultRelayServerUrl, senderTag);
  }
  try {
    socket.send(safeJsonStringify(payload));
  } catch (e) {
    onError(payload.id, e as Error, senderTag);
  }
}

// onOpen is called when a new WS to a relay-server is created on request from a mixnet user.
function onOpen(socket: WebSocket, senderTag: string) {
  socket.onmessage = (event: MessageEvent) => onPayload(senderTag, event);
  socket.onclose = () => onClose(socket, senderTag);
}

// onClose is called when a mixnet user request to closes its WS connection
// OR when the relay-server sends a close message to the WS.
function onClose(socket: WebSocket, senderTag: string) {
  sendMessageToMixnet('closed', senderTag);
  tagToWSConn.delete(senderTag);
}

// onPayload is called when a relay-server sends a payload to an existing WS.
// The service provider forwards the received payload to the matching mixnet user.
function onPayload(senderTag: string, e: { data: any }) {
  if (typeof e.data === "undefined") return;
  const payload: JsonRpcPayload = typeof e.data === "string" ? safeJsonParse(e.data) : e.data;
  sendMessageToMixnet(safeJsonStringify(payload), senderTag);
}

function onError(id: number, error: Error, senderTag: string) {
  //const error = parseError(e);
  const message = error.message || error.toString();
  const payload = formatJsonRpcError(id, message);
  sendMessageToMixnet(safeJsonStringify(payload), senderTag);
}

// sendMessageToMixnet sends a message to a mixnet user (wallet/dapp) identified by its sender_tag
// it relies on a Nym send function, which should be explored better to ensure correct usage.
function sendMessageToMixnet(messageContent: string, senderTag: string) {

  // Place each of the form values into a single object to be sent.
  /*const messageContentToSend = {
    text: messageContent,
    fromAddress : ourAddress
  }*/

  const message = {
    type: "reply",
    //message: JSON.stringify(messageContentToSend),
    message: messageContent,
    senderTag: senderTag
  }
  // as I'm using the senderTag, are the matching SURBs automatically retrieved => yes, this also removes all need to keep track of the SURBs!

  // Send our message object out via our websocket connection.
  mixnetWebsocketConnection.send(JSON.stringify(message));
}

// Send a message to the mixnet client, asking what our own address is.
function sendSelfAddressRequest() {
  const selfAddress = {
    type: "selfAddress",
  };
  mixnetWebsocketConnection.send(JSON.stringify(selfAddress));
}

// Function that connects our application to the mixnet Websocket. We want to call this first in our main function.
function connectWebsocket(url : string) {
  return new Promise(function (resolve, reject) {
    const server = new WebSocket(url);
    console.log('connecting to Mixnet Websocket (Nym Client)...')
    server.onopen = function () {
      resolve(server);
    };
    server.onerror = function (err) {
      reject(err);
    };

  });
}



main();
