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

import NymWsConnection from "../src/nym-ws";
import NymWsServiceProvider from "../src/nym-ws-service_provider";
import { safeJsonStringify , safeJsonParse } from "@walletconnect/safe-json";
import {
  JsonRpcError,
  JsonRpcPayload,
  JsonRpcRequest,
  JsonRpcResult,
  payloadId,
} from "@walletconnect/jsonrpc-utils";


chai.use(chaiAsPromised);

const BASE16 = "base16";

const RELAY_URL = "wss://staging.relay.walletconnect.com";

const TEST_ID = 1;
const TEST_METHOD = "test_method";
const TEST_PARAMS = { something: true };
const TEST_RESULT = true;

const TEST_JSONRPC_RESULT = {
  id: TEST_ID,
  jsonrpc: "2.0",
  result: TEST_RESULT,
};

/*
Logic should be:
Try to use the permanent staging wc relay, but create the wss connection from the
nym-ws-service-provider.ts instead of ws.ts
This is probably a useful reference: jsonrpc/ws-connection/test/index.test.ts

Once this test works, the second step is to test both nym-ws and nym-ws-service-provider
conjointly, but that implies already sending messages on the nym mixnet.
To be fair, the first step also requires the mixnet because the way the ws-service-provider works is
by starting and learning its mixnet address on start-up. So it's not that weird to have both in the same file anyway.

Both of those batch of tests are done in this file because of JS/TS resolution issue.
 */

// the actual issue was not the file name, but something happening in the second file, since now that they're merged here, I have the same error
// => Compare what I'm calling in one vs the other, the dependencies (import NymWsConnection from "../src/nym-ws"; should come from there???)
// And the difference in nym-ws is that it does import { createNymMixnetClient, NymMixnetClient, Payload, StringMessageReceivedEvent } from "@nymproject/sdk";
// More tests confirmed that it does come from import Nym SDK. => after much unsuccessful debugging, I decided to switch to using the Nym Client through WebSockets.


// the Nym client of the SP I'm spinning in the tests must match the SP Nym Address given as default in nym-ws

function generateRandomBytes32(): string {
  const random = randomBytes(32);
  return toString(random, BASE16);
}

const signJWT = async (aud: string) => {
  const keyPair = relayAuth.generateKeyPair(fromString(generateRandomBytes32(), BASE16));
  const sub = generateRandomBytes32();
  const ttl = 5000; //5 seconds
  const jwt = await relayAuth.signJWT(sub, aud, ttl, keyPair);

  return jwt;
};

const formatRelayUrl = async () => {
  const auth = await signJWT(RELAY_URL);
  return formatRelayRpcUrl({
    protocol: "wc",
    version: 2,
    sdkVersion: version,
    relayUrl: RELAY_URL,
    projectId: "3cbaa32f8fbf3cdcc87d27ca1fa68069",
    auth,
  });
};


function mockWcRpcPublish(): JsonRpcRequest {
  return {
    id: payloadId(), // hex string - 32 bytes
    jsonrpc: "2.0",
    method: "irn_publish",
    params: {
      topic: generateRandomBytes32(), //hex string - 32 bytes
      message: "test_message", // utf8 string - variable
      ttl: 30, // uint32 - 4 bytes
      tag: 123, // uint32 - 4 bytes
    },
  };
}

const senderTag = "testerToSixteenAddMor"; // That's what Nym expects as tag length.

describe("@walletconnect/nym-jsonrpc-ws-service-provider", () => {
  describe("init", () => {
    it("initialises, requires Nym client to be running", async () => {
      const SP = new NymWsServiceProvider();
      await SP.setup();
      chai.expect(SP instanceof NymWsServiceProvider).to.be.true;

      SP.terminateServiceProvider();
    });
  });

  describe("open", () => {
    it("can open a connection with a valid relay `wss:` URL", async () => {
      const SP = new NymWsServiceProvider();
      await SP.setup();

      chai.expect(SP.tagToWSConn.get(senderTag)).to.not.exist;
      await chai.expect(SP.openWStoRelay(await formatRelayUrl(), senderTag)).to.be.fulfilled;
      chai.expect(SP.tagToWSConn.get(senderTag)).to.exist;

      SP.terminateServiceProvider();
    });

    it("rejects with an error if `wss:` URL is valid but connection cannot be made", async () => {
      const auth = await signJWT(RELAY_URL);
      const rpcUrlWithoutProjectId = formatRelayRpcUrl({
        protocol: "wc",
        version: 2,
        sdkVersion: version,
        relayUrl: RELAY_URL,
        auth,
      });
      const SP = new NymWsServiceProvider();
      await SP.setup();

      await chai.expect(SP.openWStoRelay(rpcUrlWithoutProjectId, senderTag)).to.be.rejectedWith("Unexpected server response: 400");

      SP.terminateServiceProvider();
    });

    // TODO should probably check for double open here too!
  });

  describe("close", () => {
    it("can open then close a connection", async () => {
      const SP = new NymWsServiceProvider();
      await SP.setup();

      chai.expect(SP.tagToWSConn.get(senderTag)).to.not.exist;
      await chai.expect(SP.openWStoRelay(await formatRelayUrl(), senderTag)).to.be.fulfilled;
      chai.expect(SP.tagToWSConn.get(senderTag)).to.exist;
      await chai.expect(SP.closeWStoRelay(senderTag)).to.be.fulfilled;
      chai.expect(SP.tagToWSConn.get(senderTag)).to.not.exist;

      SP.terminateServiceProvider();
    });

    it("can not double close a connection, with correct error message", async () => {
      const SP = new NymWsServiceProvider();
      await SP.setup();
      let expectedError: Error | undefined;

      chai.expect(SP.tagToWSConn.get(senderTag)).to.not.exist;
      await chai.expect(SP.openWStoRelay(await formatRelayUrl(), senderTag)).to.be.fulfilled;
      chai.expect(SP.tagToWSConn.get(senderTag)).to.exist;
      await chai.expect(SP.closeWStoRelay(senderTag)).to.be.fulfilled;
      chai.expect(SP.tagToWSConn.get(senderTag)).to.not.exist;

      await chai.expect(SP.closeWStoRelay(senderTag)).to.be.rejectedWith("Connection already closed");

      SP.terminateServiceProvider();
    });
  });

  describe("forwardRPC", () => {
    it("send a valid WC RPC", async () => {
      const SP = new NymWsServiceProvider();
      await SP.setup();
      await chai.expect(SP.openWStoRelay(await formatRelayUrl(), senderTag)).to.be.fulfilled;

      const RPCpayload = mockWcRpcPublish();

      const socket: WebSocket = SP.tagToWSConn.get(senderTag);
      socket.onmessage = (e: MessageEvent) => {
        chai.expect(e.data).to.not.be.a("undefined");
        const payload: JsonRpcResult = typeof e.data === "string" ? safeJsonParse(e.data) : e.data;
        console.log(payload);
        chai.expect(payload.id).to.equal(RPCpayload.id);
        chai.expect(payload.jsonrpc).to.equal("2.0");
        chai.expect(payload.result).to.equal(true);
      };

      await chai.expect(SP.forwardRPCtoRelay(senderTag, RPCpayload)).to.be.fulfilled;

      SP.terminateServiceProvider();

      // eslint-disable-next-line promise/param-names
      await new Promise(r => setTimeout(r, 5000));
    });
  });
});



describe("@walletconnect/nym-jsonrpc-ws-E2E", () => {
  describe("init", () => {
    it("does not initialise with an invalid `ws` string", async () => {
      chai
        .expect(() => new NymWsConnection("invalid"))
        .to.throw("Provided URL is not compatible with WebSocket connection: invalid");
    });
    it("initialises with a `ws:` string", async () => {
      const conn = new NymWsConnection(await formatRelayUrl());
      chai.expect(conn instanceof NymWsConnection).to.be.true;
    });
    it("initialises with a `wss:` string", async () => {
      const conn = new NymWsConnection(await formatRelayUrl());
      chai.expect(conn instanceof NymWsConnection).to.be.true;
    });
  });

  describe("open", () => {
    it("can open a connection with a valid relay `wss:` URL", async () => {
      const SP = new NymWsServiceProvider();
      await SP.setup();
      const conn = new NymWsConnection(await formatRelayUrl());

      conn.on("open",() => {
        chai.assert(true);
        console.log("Test passing");
      });

      chai.expect(conn.connected).to.be.false;
      chai.expect(SP.tagToWSConn.size).to.equal(0);

      await chai.expect(conn.open()).to.be.fulfilled;

      chai.expect(conn.connected).to.be.true;
      chai.expect(SP.tagToWSConn.size).to.equal(1);

      conn.terminateClient();
      SP.terminateServiceProvider();

      // eslint-disable-next-line promise/param-names
      await new Promise(r => setTimeout(r, 3000));
    });
    it("rejects with an error if `wss:` URL is valid but connection cannot be made", async () => {
      const auth = await signJWT(RELAY_URL);
      const rpcUrlWithoutProjectId = formatRelayRpcUrl({
        protocol: "wc",
        version: 2,
        sdkVersion: version,
        relayUrl: RELAY_URL,
        auth,
      });
      const SP = new NymWsServiceProvider();
      await SP.setup();
      const conn = new NymWsConnection(rpcUrlWithoutProjectId);

      conn.on("payload",(payload: JsonRpcError) => {
        chai.expect(payload).to.not.be.a("undefined");
        chai.expect(payload.error.message).to.equal("Error: Couldn't open a WS to relay: Error: Unexpected server response: 400");
        console.log("Test passing");
      });

      await chai.expect(conn.open()).to.be.rejected;

      conn.terminateClient();
      SP.terminateServiceProvider();

      // eslint-disable-next-line promise/param-names
      await new Promise(r => setTimeout(r, 3000));
    });

    // TODO add a double open test while registering, to check the promise/event handling

  });

  describe("close", () => {
    it("can open then close a connection", async () => {
      const SP = new NymWsServiceProvider();
      await SP.setup();
      const conn = new NymWsConnection(await formatRelayUrl());

      conn.once("open",() => {
        chai.assert(true);
      });

      chai.expect(conn.connected).to.be.false;
      chai.expect(SP.tagToWSConn.size).to.equal(0);

      await chai.expect(conn.open()).to.be.fulfilled;

      conn.once("close",() => {
        chai.assert(true);
        console.log("Test passing");
      });

      chai.expect(conn.connected).to.be.true;
      chai.expect(SP.tagToWSConn.size).to.equal(1);

      await chai.expect(conn.close()).to.be.fulfilled;

      chai.expect(conn.connected).to.be.false;
      chai.expect(SP.tagToWSConn.size).to.equal(0);


      SP.terminateServiceProvider();

      // eslint-disable-next-line promise/param-names
      await new Promise(r => setTimeout(r, 3000));
    });

    it("can not double close a connection, with correct error message", async () => {
      const SP = new NymWsServiceProvider();
      await SP.setup();
      const conn = new NymWsConnection(await formatRelayUrl());

      conn.once("open",() => {
        chai.assert(true);
      });

      chai.expect(conn.connected).to.be.false;
      chai.expect(SP.tagToWSConn.size).to.equal(0);

      await chai.expect(conn.open()).to.be.fulfilled;

      conn.once("close",() => {
        chai.assert(true);
      });

      chai.expect(conn.connected).to.be.true;
      chai.expect(SP.tagToWSConn.size).to.equal(1);

      await chai.expect(conn.close()).to.be.fulfilled;

      chai.expect(conn.connected).to.be.false;
      chai.expect(SP.tagToWSConn.size).to.equal(0);

      await chai.expect(conn.close()).to.be.rejectedWith("Connection already closed");

      SP.terminateServiceProvider();

      // eslint-disable-next-line promise/param-names
      await new Promise(r => setTimeout(r, 3000));
    });
  });

  describe("forwardRPC", () => {
    it("send a valid WC RPC", async () => {
      const SP = new NymWsServiceProvider();
      await SP.setup();
      const conn = new NymWsConnection(await formatRelayUrl());

      conn.once("open",() => {
        chai.assert(true);
      });

      await chai.expect(conn.open()).to.be.fulfilled;

      const RPCpayload = mockWcRpcPublish();

      conn.once("payload",(payload: string) => {
        chai.expect(payload).to.not.be.a("undefined");
        const parsedPayload = safeJsonParse(payload);
        chai.expect(parsedPayload.id).to.equal(RPCpayload.id);
        chai.expect(parsedPayload.jsonrpc).to.equal("2.0");
        chai.expect(parsedPayload.result).to.equal(true);
      });

      try {
        await chai.expect(conn.send(RPCpayload)).to.be.fulfilled;
      } catch (error) {
        chai.expect(true).to.be.false; // hacky way to make the test fail if an error is caught
      }

      // eslint-disable-next-line promise/param-names
      await new Promise(r => setTimeout(r, 3000));

      conn.terminateClient();
      SP.terminateServiceProvider();

      // eslint-disable-next-line promise/param-names
      await new Promise(r => setTimeout(r, 3000));
    });
    // TODO test with 2 or 3 users
  });
});
