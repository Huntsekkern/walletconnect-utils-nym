import "mocha";
import * as chai from "chai";
import chaiAsPromised from "chai-as-promised";
import { WsConnection } from "./../src/ws";
import { RELAY_URL } from "./shared/values";
import * as relayAuth from "@walletconnect/relay-auth";
import { toString } from "uint8arrays";
import { randomBytes } from "@stablelib/random";
import { formatRelayRpcUrl } from "@walletconnect/utils";
import { version } from "@walletconnect/utils/package.json";
import { fromString } from "uint8arrays/from-string";

import NymWsConnection from "./nym-ws";
import NymWsServiceProvider from "./nym-ws-service_provider";
import { describe } from "node:test"; // TODO not sure this is correct, and should rather install mocha

chai.use(chaiAsPromised);



const BASE16 = "base16";


const RELAY_URL = "wss://staging.relay.walletconnect.com";

/*
Logic should be:
Try to use the permanent staging wc relay, but create the wss connection from the
nym-ws-service-provider.ts instead of ws.ts
This is probably a useful reference: jsonrpc/ws-connection/test/index.test.ts

Once this test works, the second step would be to test both nym-ws and nym-ws-service-provider
conjointly, but that implies already sending messages on the nym mixnet.
Not sure I want to do that as part of the regular test suite...
There is however no real alternative as far as I can think of,
apart from manual testing of course, but which is nearly equivalent.

Let's then say that this second batch of test will be in another file,
and that the current file is only taking inspiration from jsonrpc/ws-connection/test/index.test.ts
but with the service provider instead of the WC client.
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


describe("@walletconnect/nym-jsonrpc-ws-service-provider", () => {
  describe("init", () => {
    it("initialises, requires Nym client to be running", async () => {
      const SP = new NymWsServiceProvider();
      chai.expect(SP instanceof NymWsServiceProvider).to.be.true;
    });
  });

  describe("open", () => {
    it("can open a connection with a valid relay `wss:` URL", async () => {
      const SP = new NymWsServiceProvider();
      const senderTag = "tester";

      chai.expect(SP.tagToWSConn.get(senderTag)).to.not.exist;
      await SP.openWS(await formatRelayUrl(), senderTag);
      chai.expect(SP.tagToWSConn.get(senderTag)).to.exist;
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
      const senderTag = "tester";
      let expectedError: Error | undefined;

      try {
        await SP.openWS(rpcUrlWithoutProjectId, senderTag);
      } catch (error) {
        expectedError = error;
      }
      chai.expect(expectedError instanceof Error).to.be.true;
      chai.expect((expectedError as Error).message).to.equal("Unexpected server response: 400");
    });


  });

  describe("close", () => {
    it("can open than close a connection", async () => {
      const SP = new NymWsServiceProvider();
      const senderTag = "tester";
      let expectedError: Error | undefined;


      chai.expect(SP.tagToWSConn.get(senderTag)).to.not.exist;
      await SP.openWS(await formatRelayUrl(), senderTag);
      chai.expect(SP.tagToWSConn.get(senderTag)).to.exist;
      await SP.closeWS(senderTag);
      chai.expect(SP.tagToWSConn.get(senderTag)).to.not.exist;
    });
    it("can not double close a connection, with correct error message", async () => {
      const SP = new NymWsServiceProvider();
      const senderTag = "tester";
      let expectedError: Error | undefined;


      chai.expect(SP.tagToWSConn.get(senderTag)).to.not.exist;
      await SP.openWS(await formatRelayUrl(), senderTag);
      chai.expect(SP.tagToWSConn.get(senderTag)).to.exist;
      await SP.closeWS(senderTag);
      chai.expect(SP.tagToWSConn.get(senderTag)).to.not.exist;

      try {
        await SP.closeWS(senderTag);
      } catch (error) {
        expectedError = error;
      }

      chai.expect(expectedError instanceof Error).to.be.true;
      chai.expect((expectedError as Error).message).to.equal("Connection already closed");
    });
  });

  describe("forwardRPC", () => {
    it("send a valid WC RPC", async () => {
      const SP = new NymWsServiceProvider();
      const senderTag = "tester";
      await SP.openWS(await formatRelayUrl(), senderTag);

      const RPCpayload = mockWcRpc();

      try {
        await SP.forwardRPC(senderTag, RPCpayload);
      } catch (error) {
        chai.expect(true).to.be.false; // hacky way to make the test fail if an error is caught
      }

      // TODO might try to listen/catch to the onPayload response

    });
  });
});


// TODO the whole tests with the nym-ws.ts

