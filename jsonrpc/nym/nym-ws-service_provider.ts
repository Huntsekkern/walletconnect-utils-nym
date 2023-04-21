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
    let response = JSON.parse(responseMessageEvent.data.toString());
    if (response.type == "error") {
      console.log("\x1b[91mAn error occured: " + response.message + "\x1b[0m")
    } else if (response.type == "selfAddress") {
      ourAddress = response.address;
      console.log("\x1b[94mOur address is: " + ourAddress + "\x1b[0m")
    } else if (response.type == "received") {
      // Those are the messages received from the mixnet, i.e., from the wallets and dapps.
      handleReceivedMixnetMessage(response)
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
    tagToWSConn.set(senderTag, socket);
    WSConnToSurbs.set(socket, replySURBs);
  } else if (payload == "close") {
    closeWS(senderTag)
  } else { // Then the message is a JSONRPC to be passed to the relay server

  }


  console.log('\x1b[93mReceived : \x1b[0m');
  console.log('\x1b[92mName : ' + messageContent.name + '\x1b[0m');
  console.log('\x1b[92mService : ' + messageContent.service + '\x1b[0m');
  console.log('\x1b[92mComment : ' + messageContent.comment + '\x1b[0m');

  console.log('\x1b[93mSending response back to client... \x1b[0m')

  sendMessageToMixnet(response.senderTag)
}

function sendMessageToMixnet(senderTag: string) {

  // Place each of the form values into a single object to be sent.
  const messageContentToSend = {
    text: 'We received your request - this reply sent to you anonymously with SURBs',
    fromAddress : ourAddress
  }

  const message = {
    type: "reply",
    message: JSON.stringify(messageContentToSend),
    senderTag: senderTag
  }

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
      this.onClose(event);
      resolve();
    };

    socket.close();
  });
}

main();
