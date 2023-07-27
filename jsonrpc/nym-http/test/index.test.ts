/* eslint-disable no-console */
import "mocha";
import * as chai from "chai";
import chaiAsPromised from "chai-as-promised";
import * as relayAuth from "@walletconnect/relay-auth";
import { toString } from "uint8arrays";
import { randomBytes } from "@stablelib/random";
import { formatRelayRpcUrl } from "@walletconnect/utils";
import { version } from "@walletconnect/utils/package.json";
import { fromString } from "uint8arrays/from-string";

import NymHttpConnection from "../src/nym-http";
import NymServiceProvider from "../../nym-SP/src/nym-service_provider";
import { safeJsonStringify , safeJsonParse } from "@walletconnect/safe-json";
import {
  JsonRpcError,
  JsonRpcPayload,
  JsonRpcRequest,
  JsonRpcResult,
  payloadId,
} from "@walletconnect/jsonrpc-utils";

import WebSocket from "ws";
import fetch from "cross-fetch";


chai.use(chaiAsPromised);

const BASE16 = "base16";

const BASIC_RPC_URL = "http://localhost:8545";
// const RPC_URL = "https://rpc.walletconnect.com/v1";
// const FULL_RPC_URL = "https://rpc.walletconnect.com/v1?chainId=eip155:NaN&projectId=c03b16589879d4baec1782274cba4ff5";
const FULL_RPC_URL = "https://rpc.ankr.com/eth";
// This is an external ETH provider, but hey, it answers better than the rpc of walletconnect.

const DEFAULT_HTTP_HEADERS = {
  Accept: "application/json",
  "Content-Type": "application/json",
};

const DEFAULT_HTTP_METHOD = "POST";

const DEFAULT_FETCH_OPTS = {
  headers: DEFAULT_HTTP_HEADERS,
  method: DEFAULT_HTTP_METHOD,
};


/*
Logic should be:
Test the nym-http-connection, through the mixnet, through the SP, to the node.
 */

// the actual issue was not the file name, but something happening in the second file, since now that they're merged here, I have the same error
// => Compare what I'm calling in one vs the other, the dependencies (import NymWsConnection from "../src/nym-ws"; should come from there???)
// And the difference in nym-ws is that it does import { createNymMixnetClient, NymMixnetClient, Payload, StringMessageReceivedEvent } from "@nymproject/sdk";
// More tests confirmed that it does come from import Nym SDK. => after much unsuccessful debugging, I decided to switch to using the Nym Client through WebSockets.


// the Nym client of the SP I'm spinning in the tests must match the SP Nym Address given as default in nym-ws

/*
    ./nym/target/release/nym-client run --id wc-test-client2 -p 1977
    ./nym/target/release/nym-client run --id sp-test-client2 -p 1978
    ./nym/target/release/nym-client run --id http-test-client1 -p 1990
 */

function generateRandomBytes32(): string {
  const random = randomBytes(32);
  return toString(random, BASE16);
}

/*const signJWT = async (aud: string) => {
  const keyPair = relayAuth.generateKeyPair(fromString(generateRandomBytes32(), BASE16));
  const sub = generateRandomBytes32();
  const ttl = 5000; //5 seconds
  const jwt = await relayAuth.signJWT(sub, aud, ttl, keyPair);

  return jwt;
};*/

/*const formatRelayUrl = async () => {
  const auth = await signJWT(RPC_URL);
  return formatRelayRpcUrl({
    protocol: "wc",
    version: 2,
    sdkVersion: version,
    relayUrl: RPC_URL,
    projectId: "3cbaa32f8fbf3cdcc87d27ca1fa68069",
    auth,
  });
};*/



function mockGasPrice(): JsonRpcRequest {
  return {
    id: payloadId(), // hex string - 32 bytes
    jsonrpc: "2.0",
    method: "eth_gasPrice",
    params: [],
  };
}

function mockBlockByNumber(): JsonRpcRequest {
  return {
    id: payloadId(), // hex string - 32 bytes
    jsonrpc: "2.0",
    method: "eth_getBlockByNumber",
    params: [ "latest", false ],
  };
}

function mockGasPriceString(): string {
  return "{\"id\":\"1690362322571120640\",\"jsonrpc\":\"2.0\",\"method\":\"eth_gasPrice\",\"params\":[]}";
}
function mockBlockByNumberString(): string {
  return "{\"id\":\"1690362322571984640\",\"jsonrpc\":\"2.0\",\"method\":\"eth_getBlockByNumber\",\"params\":[\"latest\",false]}";
}

const senderTag = "testerToSixteenAddMor"; // That's what Nym expects as tag length.

async function connectToMixnet(): Promise<WebSocket> {
    const port = "1990";
    const localClientUrl = "ws://127.0.0.1:" + port;
    let sharedMixnetWebsocketConnection: WebSocket | any;

    // Set up and handle websocket connection to our desktop client.
    sharedMixnetWebsocketConnection = await connectWebsocket(localClientUrl).then(function (c) {
      return c;
    }).catch((err) => {
      console.log("Websocket connection error on the user. Is the client running with <pre>--connection-type WebSocket</pre> on port " + port + "?");
      console.log(err);
      return new Promise((resolve, reject) => {
        reject(err.error);
      });
    });

    // TODO can also introduce this refactored promise in the other place
    return new Promise((resolve, reject) => {
      if (!sharedMixnetWebsocketConnection) {
        const err = new Error("Oh no! Could not create client");
        console.error(err);
        reject(err);
      } else {
        resolve(sharedMixnetWebsocketConnection);
      }
    });
}

// TODO I guess changing Promise<void> to Promise<WebSocket> will work. If it does, I can make that change everywhere else
// Function that connects our application to the mixnet Websocket. We want to call this when registering.
function connectWebsocket(url: string): Promise<WebSocket> {
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



describe("@walletconnect/nym-jsonrpc-http-E2E", () => {
  describe("init", () => {
    it("initialises SP, requires Nym client to be running", async () => {
      const SP = new NymServiceProvider();
      await SP.setup();

      chai.expect(SP instanceof NymServiceProvider).to.be.true;

      SP.terminateServiceProvider();
    });
    it("does not initialise with an invalid `http` string", async () => {
      const sharedMixnetWebsocketConnection = await connectToMixnet();

      chai
        .expect(() => new NymHttpConnection("invalid", true, sharedMixnetWebsocketConnection))
        .to.throw("Provided URL is not compatible with HTTP connection: invalid");

      sharedMixnetWebsocketConnection.close();
    });
    it("initialises with a `http:` string", async () => {
      const sharedMixnetWebsocketConnection = await connectToMixnet();

      const conn = new NymHttpConnection(BASIC_RPC_URL, true, sharedMixnetWebsocketConnection);


      chai.expect(conn instanceof NymHttpConnection).to.be.true;

      await conn.open();

      await conn.close();
      sharedMixnetWebsocketConnection.close();
    });
    it("initialises with a `https:` string", async () => {
      const sharedMixnetWebsocketConnection = await connectToMixnet();

      const conn = new NymHttpConnection(FULL_RPC_URL, true, sharedMixnetWebsocketConnection);
      chai.expect(conn instanceof NymHttpConnection).to.be.true;

      await conn.open();

      await conn.close();
      sharedMixnetWebsocketConnection.close();
    });
    it("initialises with a `https:` string with ping", async () => {
      // This test passes as long as the RPC pings back. Like the vanilla http-connection, it does not check for the
      // content of the response. But with the current URL, the chain ID is not supported.
      const SP = new NymServiceProvider();
      await SP.setup();

      const sharedMixnetWebsocketConnection = await connectToMixnet();


      const conn = new NymHttpConnection(FULL_RPC_URL, false, sharedMixnetWebsocketConnection);
      chai.expect(conn instanceof NymHttpConnection).to.be.true;

      await chai.expect(conn.open()).to.be.fulfilled;

      await conn.close();
      sharedMixnetWebsocketConnection.close();
      SP.terminateServiceProvider();
    });
  });

  describe("fetch", () => {
    it("can reach the RPC-node", async () => {
      const SP = new NymServiceProvider();
      await SP.setup();
      const sharedMixnetWebsocketConnection = await connectToMixnet();
      const url = FULL_RPC_URL;

      const conn = new NymHttpConnection(url, false, sharedMixnetWebsocketConnection);
      await chai.expect(conn.open()).to.be.fulfilled;

      const requestPayload = mockGasPrice();

      conn.on("payload",payload => {
        chai.assert(true);
        console.log("Test passing");
      });

      await chai.expect(conn.send(requestPayload)).to.be.fulfilled;

      await conn.close();
      sharedMixnetWebsocketConnection.close();
      SP.terminateServiceProvider();
    });

    it("fetch a valid answer for gasPrice", async () => {
      const SP = new NymServiceProvider();
      await SP.setup();
      const sharedMixnetWebsocketConnection = await connectToMixnet();
      const url = FULL_RPC_URL;

      const conn = new NymHttpConnection(url, false, sharedMixnetWebsocketConnection);
      await chai.expect(conn.open()).to.be.fulfilled;

      const requestPayload = mockGasPrice();

      const body = safeJsonStringify(requestPayload);
      const resVanilla = await fetch(url, { ...DEFAULT_FETCH_OPTS, body });
      const dataVanilla = await resVanilla.json();

      conn.on("payload",payload => {
        chai.assert(true);
        chai.expect(payload.jsonrpc).to.equal("2.0");
        chai.expect(payload.id).to.equal(dataVanilla.id);
        // chai.expect(payload).to.deep.equal(dataVanilla); // I wish I could run this check, but sometimes the gas price changes between the fetch here and the SP fetch now that I'm running on real nodes.
        chai.expect(payload.status).to.not.equal("FAILED");
        console.log("Test passing");
      });

      await chai.expect(conn.send(requestPayload)).to.be.fulfilled;

      await conn.close();
      sharedMixnetWebsocketConnection.close();
      SP.terminateServiceProvider();
    });

    it("fetch a valid answer for blockByNumber", async () => {
      const SP = new NymServiceProvider();
      await SP.setup();
      const sharedMixnetWebsocketConnection = await connectToMixnet();
      const url = FULL_RPC_URL;

      const conn = new NymHttpConnection(url, false, sharedMixnetWebsocketConnection);
      await chai.expect(conn.open()).to.be.fulfilled;

      const requestPayload = mockBlockByNumber();

      const body = safeJsonStringify(requestPayload);
      const resVanilla = await fetch(url, { ...DEFAULT_FETCH_OPTS, body });
      const dataVanilla = await resVanilla.json();

      conn.on("payload",payload => {
        chai.assert(true);
        chai.expect(payload.jsonrpc).to.equal("2.0");
        chai.expect(payload.id).to.equal(dataVanilla.id);
        // chai.expect(payload).to.deep.equal(dataVanilla); // I wish I could run this check, but sometimes the gas price changes between the fetch here and the SP fetch now that I'm running on real nodes.
        chai.expect(payload.status).to.not.equal("FAILED");
        console.log("Test passing");
      });

      await chai.expect(conn.send(requestPayload)).to.be.fulfilled;

      await conn.close();
      sharedMixnetWebsocketConnection.close();
      SP.terminateServiceProvider();
    });

    it("fetch a valid answer from 3 different connections", async () => {
      const SP = new NymServiceProvider();
      await SP.setup();
      const sharedMixnetWebsocketConnection = await connectToMixnet();
      const url = FULL_RPC_URL;

      const conn1 = new NymHttpConnection(url, false, sharedMixnetWebsocketConnection);
      const conn2 = new NymHttpConnection(url, false, sharedMixnetWebsocketConnection);
      const conn3 = new NymHttpConnection(url, false, sharedMixnetWebsocketConnection);

      conn1.once("open",() => {
        chai.assert(true);
      });
      conn2.once("open",() => {
        chai.assert(true);
      });
      conn3.once("open",() => {
        chai.assert(true);
      });

      await chai.expect(conn1.open()).to.be.fulfilled;
      await chai.expect(conn2.open()).to.be.fulfilled;
      await chai.expect(conn3.open()).to.be.fulfilled;



      const RPCpayload1 = mockGasPrice();
      const RPCpayload2 = mockGasPrice();
      const RPCpayload3 = mockBlockByNumber();

      let body = safeJsonStringify(RPCpayload1);
      const resVanilla1 = await fetch(url, { ...DEFAULT_FETCH_OPTS, body });
      const dataVanilla1 = await resVanilla1.json();

      body = safeJsonStringify(RPCpayload2);
      const resVanilla2 = await fetch(url, { ...DEFAULT_FETCH_OPTS, body });
      const dataVanilla2 = await resVanilla2.json();

      body = safeJsonStringify(RPCpayload3);
      const resVanilla3 = await fetch(url, { ...DEFAULT_FETCH_OPTS, body });
      const dataVanilla3 = await resVanilla3.json();

      conn1.once("payload",(payload) => {
        chai.expect(payload).to.not.be.a("undefined");
        chai.expect(payload.jsonrpc).to.equal("2.0");
        chai.expect(payload.id).to.equal(dataVanilla1.id);
        // chai.expect(payload).to.deep.equal(dataVanilla1); // I wish I could run this check, but sometimes the gas price changes between the fetch here and the SP fetch now that I'm running on real nodes.

        chai.expect(payload.status).to.not.equal("FAILED");
        console.log("Test passing for 1");
      });
      conn2.once("payload",(payload) => {
        chai.expect(payload).to.not.be.a("undefined");
        chai.expect(payload.jsonrpc).to.equal("2.0");
        chai.expect(payload.id).to.equal(dataVanilla2.id);
        // chai.expect(payload).to.deep.equal(dataVanilla2); // I wish I could run this check, but sometimes the gas price changes between the fetch here and the SP fetch now that I'm running on real nodes.
        chai.expect(payload.status).to.not.equal("FAILED");
        console.log("Test passing for 2");
      });
      conn3.once("payload",(payload) => {
        chai.expect(payload).to.not.be.a("undefined");
        chai.expect(payload.jsonrpc).to.equal("2.0");
        chai.expect(payload.id).to.equal(dataVanilla3.id);
        // chai.expect(payload).to.deep.equal(dataVanilla3); // I wish I could run this check, but sometimes the gas price changes between the fetch here and the SP fetch now that I'm running on real nodes.
        chai.expect(payload.status).to.not.equal("FAILED");
        console.log("Test passing for 3");
      });

      await chai.expect(conn1.send(RPCpayload1)).to.be.fulfilled;
      await chai.expect(conn2.send(RPCpayload2)).to.be.fulfilled;
      await chai.expect(conn3.send(RPCpayload3)).to.be.fulfilled;


      await conn1.close();
      await conn2.close();
      await conn3.close();
      sharedMixnetWebsocketConnection.close();
      SP.terminateServiceProvider();

      // eslint-disable-next-line promise/param-names
      // await new Promise(r => setTimeout(r, 3000));
    });
  });
});
