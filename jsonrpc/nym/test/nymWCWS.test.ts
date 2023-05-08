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
import { safeJsonStringify } from "@walletconnect/safe-json";
import { JsonRpcRequest } from "@walletconnect/jsonrpc-utils";

chai.use(chaiAsPromised);

const BASE16 = "base16";

const RELAY_URL = "wss://staging.relay.walletconnect.com";

const TEST_ID = 1;
const TEST_METHOD = "test_method";
const TEST_PARAMS = { something: true };

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

function mockWcRpcString(): string {
  return safeJsonStringify(
    {
      "id" : "1",
      "jsonrpc": "2.0",
      "method": "irn_publish",
      "params" : {
        "topic" : "test_topic",
        "message" : "test_message",
        "ttl" : 30,
        "tag" : 123,
      },
    });
}

function mockWcRpcBasic(): JsonRpcRequest {
  return {
    id: TEST_ID,
    jsonrpc: "2.0",
    method: TEST_METHOD,
    params: TEST_PARAMS,
  };
}

function mockWcRpcPublish(): JsonRpcRequest {
  return {
    id: TEST_ID,
    jsonrpc: "2.0",
    method: "irn_publish",
    params: {
      topic: "test_topic",
      message: "test_message",
      ttl: 30,
      tag: 123,
    },
  };
}

// TODO fix that the SP I'm spinning in the tests match the SP Nym Address given as default in nym-ws

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
      const conn = new NymWsConnection(await formatRelayUrl());

      chai.expect(conn.connected).to.be.false;
      chai.expect(SP.tagToWSConn.keys).to.be.empty;
      await conn.open();
      chai.expect(conn.connected).to.be.true;
      chai.expect(SP.tagToWSConn.keys).to.not.be.empty;
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
      const conn = new NymWsConnection(rpcUrlWithoutProjectId);
      let expectedError: Error | undefined;

      try {
        await conn.open();
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
      const conn = new NymWsConnection(await formatRelayUrl());
      let expectedError: Error | undefined;

      chai.expect(conn.connected).to.be.false;
      chai.expect(SP.tagToWSConn.keys).to.be.empty;
      await conn.open();
      chai.expect(conn.connected).to.be.true;
      chai.expect(SP.tagToWSConn.keys).to.not.be.empty;
      await conn.close();
      chai.expect(conn.connected).to.be.false;
      chai.expect(SP.tagToWSConn.keys).to.be.empty;
    });

    it("can not double close a connection, with correct error message", async () => {
      const SP = new NymWsServiceProvider();
      const conn = new NymWsConnection(await formatRelayUrl());
      let expectedError: Error | undefined;

      chai.expect(conn.connected).to.be.false;
      chai.expect(SP.tagToWSConn.keys).to.be.empty;
      await conn.open();
      chai.expect(conn.connected).to.be.true;
      chai.expect(SP.tagToWSConn.keys).to.not.be.empty;
      await conn.close();
      chai.expect(conn.connected).to.be.false;
      chai.expect(SP.tagToWSConn.keys).to.be.empty;

      try {
        await conn.close();
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
      const conn = new NymWsConnection(await formatRelayUrl());
      await conn.open();

      const RPCpayload = mockWcRpcPublish();

      try {
        await conn.send(RPCpayload);
      } catch (error) {
        chai.expect(true).to.be.false; // hacky way to make the test fail if an error is caught
      }

      // the console.logs should happen automatically for the answers, but it would be good to check them
      // to ensure that everything works smoothly.

    });
  });
});