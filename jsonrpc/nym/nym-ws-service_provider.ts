import WebSocket, { MessageEvent } from "ws";
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

const tagToWSConn: Map<string, WebSocket> = new Map();
const WSConnToSurbs: Map<WebSocket, SURBs[]> = new Map();

var ourAddress:          string;
var mixnetWebsocketConnection: any;

// TODO might want to do it in a class instead of a main function?

async function main() {
  var port = '1978'
  var localClientUrl = "ws://127.0.0.1:" + port;


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



// Handle any messages that come back down the websocket.
function handleResponse(responseMessageEvent : MessageEvent) {

  try {
    let message = JSON.parse(responseMessageEvent.data.toString());
    if (message.type == "error") {
      console.log("\x1b[91mAn error occured: " + message.message + "\x1b[0m")
    } else if (message.type == "selfAddress") {
      ourAddress = message.address;
      console.log("\x1b[94mOur address is: " + ourAddress + "\x1b[0m")
    } else if (message.type == "received") {
      // Those are the messages received from the mixnet, i.e., from the wallets and dapps.
      handleReceivedMixnetMessage(message)
    }
  } catch (_) {
    console.log('something went wrong in handleResponse')
  }
}




function handleReceivedMixnetMessage(response: any) {
  let messageContent = JSON.parse(response.message);
  let replySURBs = response.replySurbs; // TODO should be an array of SURBs, if not modify accordingly.

  // TODO really not sure about the layers of JSON here, doc unclear, will have to try and look at what come through.
  //let senderTag = response.senderTag;
  let senderTag = messageContent.senderTag;
  //let payload = response.payload;
  let payload = messageContent.payload;

  if (payload.startsWith("open")) {
    // extract the url from the payload which pattern should be open:url
    const url = payload.substring(5);
    if (!isWsUrl(url)) {
      // TODO : error, either choose a relay server url or transmit error to user?
    }
    const opts = !isReactNative() ? { rejectUnauthorized: !isLocalhostUrl(url) } : undefined;
    const socket: WebSocket = new WebSocket(url, [], opts);
    // might want to spin the above into another proper function with async/await too, as in ws.ts register
    (socket as any).on("error", (errorEvent: any) => {
      console.log(errorEvent);
    });
    socket.onopen = () => {
      tagToWSConn.set(senderTag, socket);
      WSConnToSurbs.set(socket, replySURBs);
      onOpen(socket, senderTag);
    };

  } else if (payload == "close") {
    closeWS(senderTag)
  } else { // Then the message is a JSONRPC to be passed to the relay server
    forwardRPC(senderTag, payload)
  }


  console.log('\x1b[93mReceived : \x1b[0m');
  console.log('\x1b[92mName : ' + messageContent.name + '\x1b[0m');
  console.log('\x1b[92mService : ' + messageContent.service + '\x1b[0m');
  console.log('\x1b[92mComment : ' + messageContent.comment + '\x1b[0m');

  console.log('\x1b[93mSending response back to client... \x1b[0m')

  sendMessageToMixnet('nothing relevant', response.senderTag);
}


function forwardRPC(senderTag: string, payload: any) {
  const socket = tagToWSConn.get(senderTag);
  if (typeof socket === "undefined") {
    // TODO do I return an error to the client or do I open a new WS connection to the relay server?
    // I'd say the second option. But I'm lacking the url now...
  }
  try {
    socket.send(safeJsonStringify(payload));
  } catch (e) {
    // TODO
    // onError(payload.id, e as Error);
  }
}

function onOpen(socket: WebSocket, senderTag: string) {
  socket.onmessage = (event: MessageEvent) => onPayload(senderTag, event);
  socket.onclose = event => onClose(socket, senderTag);
}

function onClose(socket: WebSocket, senderTag: string) {
  sendMessageToMixnet('close', senderTag);
  WSConnToSurbs.delete(socket);
  tagToWSConn.delete(senderTag);
}

function onPayload(senderTag: string, e: { data: any }) {
  if (typeof e.data === "undefined") return;
  const payload: JsonRpcPayload = typeof e.data === "string" ? safeJsonParse(e.data) : e.data;
  sendMessageToMixnet(safeJsonStringify(payload), senderTag);
}


function sendMessageToMixnet(messageContent: string, senderTag: string) {

  // Place each of the form values into a single object to be sent.
  const messageContentToSend = {
    text: messageContent,
    fromAddress : ourAddress
  }

  const message = {
    type: "reply",
    message: JSON.stringify(messageContentToSend),
    senderTag: senderTag
  }
  // TODO as I'm using the senderTag, are the matching SURBs automatically retrieved??
  // If not, I could either pass 1 surb directly (not too hard as the socket is available from where I'm making the call)
  // Or retrieve them here from senderTag => WSConn => SURBs. But in that case, maybe better to make the 2nd map a senderTag:SURBs.

  // Send our message object out via our websocket connection.
  mixnetWebsocketConnection.send(JSON.stringify(message));
}

// Send a message to the mixnet client, asking what our own address is.
function sendSelfAddressRequest() {
  var selfAddress = {
    type: "selfAddress"
  }
  mixnetWebsocketConnection.send(JSON.stringify(selfAddress));
}

// Function that connects our application to the mixnet Websocket. We want to call this first in our main function.
function connectWebsocket(url : string) {
  return new Promise(function (resolve, reject) {
    var server = new WebSocket(url);
    console.log('connecting to Mixnet Websocket (Nym Client)...')
    server.onopen = function () {
      resolve(server);
    };
    server.onerror = function (err) {
      reject(err);
    };

  });
}

function closeWS(senderTag: string): Promise<void> {
  const socket: WebSocket = tagToWSConn.get(senderTag);

  return new Promise<void>((resolve, reject) => {
    if (typeof socket === "undefined") {
      reject(new Error("Connection already closed"));
      return;
    }

    socket.onclose = event => {
      onClose(socket, event);
      resolve();
    };

    socket.close();
  });
}

main();
