/* eslint-disable no-console */
import "mocha";
import WebSocket, { MessageEvent } from "ws";
import * as chai from "chai";
import chaiAsPromised from "chai-as-promised";
import * as relayAuth from "@walletconnect/relay-auth";
import { toString } from "uint8arrays";
import { randomBytes } from "@stablelib/random";
import { formatRelayRpcUrl } from "@walletconnect/utils";
import { version } from "@walletconnect/utils/package.json";
import { fromString } from "uint8arrays/from-string";

import NymServiceProvider from "../../nym-SP/src/nym-service_provider";
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


/*
Logic should be:
Try to use the permanent staging wc relay, but create the wss connection from the
nym-ws-service-provider.ts instead of ws.ts
This is probably a useful reference: jsonrpc/ws-connection/test/index.test.ts
 */

// the actual issue was not the file name, but something happening in the second file, since now that they're merged here, I have the same error
// => Compare what I'm calling in one vs the other, the dependencies (import NymWsConnection from "../src/nym-ws"; should come from there???)
// And the difference in nym-ws is that it does import { createNymMixnetClient, NymMixnetClient, Payload, StringMessageReceivedEvent } from "@nymproject/sdk";
// More tests confirmed that it does come from import Nym SDK. => after much unsuccessful debugging, I decided to switch to using the Nym Client through WebSockets.


// the Nym client of the SP I'm spinning in the tests must match the SP Nym Address given as default in nym-ws

/*
./nym/target/release/nym-client run --id wc-test-client2 -p 1977
./nym/target/release/nym-client run --id sp-test-client2 -p 1978
+ for the last test
./nym/target/release/nym-client run --id wc-test-client79 -p 1979
./nym/target/release/nym-client run --id wc-test-client80 -p 1980
 */

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
      const SP = new NymServiceProvider();
      await SP.setup();
      chai.expect(SP instanceof NymServiceProvider).to.be.true;

      SP.terminateServiceProvider();
    });
  });

  describe("open", () => {
    it("can open a connection with a valid relay `wss:` URL", async () => {
      const SP = new NymServiceProvider();
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
      const SP = new NymServiceProvider();
      await SP.setup();

      await chai.expect(SP.openWStoRelay(rpcUrlWithoutProjectId, senderTag)).to.be.rejectedWith("Unexpected server response: 400");

      SP.terminateServiceProvider();
    });

    it("can open a connection, then gracefully pretends to open a new connection while just reusing the same one", async () => {
      const SP = new NymServiceProvider();
      await SP.setup();

      chai.expect(SP.tagToWSConn.get(senderTag)).to.not.exist;
      await chai.expect(SP.openWStoRelay(await formatRelayUrl(), senderTag)).to.be.fulfilled;
      chai.expect(SP.tagToWSConn.get(senderTag)).to.exist;

      await chai.expect(SP.openWStoRelay(await formatRelayUrl(), senderTag)).to.be.fulfilled;
      chai.expect(SP.tagToWSConn.get(senderTag)).to.exist;

      SP.terminateServiceProvider();
    });
  });

  describe("close", () => {
    it("can open then close a connection", async () => {
      const SP = new NymServiceProvider();
      await SP.setup();

      chai.expect(SP.tagToWSConn.get(senderTag)).to.not.exist;
      await chai.expect(SP.openWStoRelay(await formatRelayUrl(), senderTag)).to.be.fulfilled;
      chai.expect(SP.tagToWSConn.get(senderTag)).to.exist;
      await chai.expect(SP.closeWStoRelay(senderTag)).to.be.fulfilled;
      chai.expect(SP.tagToWSConn.get(senderTag)).to.not.exist;

      SP.terminateServiceProvider();
    });

    it("can not double close a connection, with correct error message", async () => {
      const SP = new NymServiceProvider();
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
      const SP = new NymServiceProvider();
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


