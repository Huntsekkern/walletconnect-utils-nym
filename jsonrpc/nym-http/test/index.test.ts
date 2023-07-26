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


chai.use(chaiAsPromised);

const BASE16 = "base16";

const RPC_URL = "https://rpc.walletconnect.com/v1";

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
  const auth = await signJWT(RPC_URL);
  return formatRelayRpcUrl({
    protocol: "wc",
    version: 2,
    sdkVersion: version,
    relayUrl: RPC_URL,
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


describe("@walletconnect/nym-jsonrpc-http-E2E", () => {
  describe("init", () => {
    it("initialises SP, requires Nym client to be running", async () => {
      const SP = new NymServiceProvider();
      await SP.setup();
      chai.expect(SP instanceof NymServiceProvider).to.be.true;

      SP.terminateServiceProvider();
    });
    it("does not initialise with an invalid `http` string", async () => {
      chai
        .expect(() => new NymHttpConnection("invalid"))
        .to.throw("Provided URL is not compatible with HTTP connection: invalid");
    });
/*    it("initialises with a `http:` string", async () => {
      const conn = new NymHttpConnection(await formatRelayUrl());
      chai.expect(conn instanceof NymHttpConnection).to.be.true;
    });*/
    it("initialises with a `https:` string", async () => {
      const conn = new NymHttpConnection(await formatRelayUrl());
      chai.expect(conn instanceof NymHttpConnection).to.be.true;
    });
  });

  describe("fetch", () => {
    it("can reach the RPC-node", async () => {
      const SP = new NymServiceProvider();
      await SP.setup();
      const conn = new NymHttpConnection(await formatRelayUrl());

      const body = safeJsonStringify(mockWcRpcPublish());

      await chai.expect(SP.proxyFetch(senderTag, RPC_URL, body)).to.be.fulfilled;

      conn.on("open",() => {
        chai.assert(true);
        console.log("Test passing");
      });

      chai.expect(conn.connected).to.be.false;
      chai.expect(SP.tagToWSConn.size).to.equal(0);

      await chai.expect(conn.open()).to.be.fulfilled;

      chai.expect(conn.connected).to.be.true;
      chai.expect(SP.tagToWSConn.size).to.equal(0);

      await conn.close();
      SP.terminateServiceProvider();

      // Those are not needed anymore, but the solution above depends on .close() working properly, which it does now, but if it starts failing, it might make pinpointing the source of error harder.
      // conn.terminateClient();
      // SP.terminateServiceProvider();
      //
      // // eslint-disable-next-line promise/param-names
      // await new Promise(r => setTimeout(r, 3000));
    });

    it("fetch a valid answer", async () => {
      const SP = new NymServiceProvider();
      await SP.setup();
      const conn = new NymHttpConnection(await formatRelayUrl());

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
        console.log("Test passing");
      });

      await chai.expect(conn.send(RPCpayload)).to.be.fulfilled;

      // eslint-disable-next-line promise/param-names
      await new Promise(r => setTimeout(r, 3000));

      await conn.close();
      SP.terminateServiceProvider();

      // Those are not needed anymore, but the solution above depends on .close() working properly, which it does now, but if it starts failing, it might make pinpointing the source of error harder.
      // conn.terminateClient();
      // SP.terminateServiceProvider();
      //
      // // eslint-disable-next-line promise/param-names
      // await new Promise(r => setTimeout(r, 3000));
    });


    // Also, this is the only test of the test suite which requires to run 4 nym clients...
    /*
    ./nym/target/release/nym-client run --id wc-test-client2 -p 1977
    ./nym/target/release/nym-client run --id sp-test-client2 -p 1978
    as usual +
    ./nym/target/release/nym-client run --id wc-test-client79 -p 1979
    ./nym/target/release/nym-client run --id wc-test-client80 -p 1980
     */
    it("fetch a valid answer from 3 different users", async () => {
      const SP = new NymServiceProvider();
      await SP.setup();
      const conn1 = new NymHttpConnection(await formatRelayUrl(), false, "1977");
      const conn2 = new NymHttpConnection(await formatRelayUrl(), false, "1979");
      const conn3 = new NymHttpConnection(await formatRelayUrl(), false, "1980");

      conn1.once("open",() => {
        chai.assert(true);
      });
      conn2.once("open",() => {
        chai.assert(true);
      });
      conn3.once("open",() => {
        chai.assert(true);
      });

      const RPCpayload1 = mockWcRpcPublish();
      const RPCpayload2 = mockWcRpcPublish();
      const RPCpayload3 = mockWcRpcPublish();

      await chai.expect(conn1.open()).to.be.fulfilled;
      await chai.expect(conn2.open()).to.be.fulfilled;
      await chai.expect(conn3.open()).to.be.fulfilled;

      conn1.once("payload",(payload: string) => {
        chai.expect(payload).to.not.be.a("undefined");
        const parsedPayload = safeJsonParse(payload);
        chai.expect(parsedPayload.id).to.equal(RPCpayload1.id);
        chai.expect(parsedPayload.jsonrpc).to.equal("2.0");
        chai.expect(parsedPayload.result).to.equal(true);
        console.log("Test passing for 1");
      });
      conn2.once("payload",(payload: string) => {
        chai.expect(payload).to.not.be.a("undefined");
        const parsedPayload = safeJsonParse(payload);
        chai.expect(parsedPayload.id).to.equal(RPCpayload2.id);
        chai.expect(parsedPayload.jsonrpc).to.equal("2.0");
        chai.expect(parsedPayload.result).to.equal(true);
        console.log("Test passing for 2");
      });
      conn3.once("payload",(payload: string) => {
        chai.expect(payload).to.not.be.a("undefined");
        const parsedPayload = safeJsonParse(payload);
        chai.expect(parsedPayload.id).to.equal(RPCpayload3.id);
        chai.expect(parsedPayload.jsonrpc).to.equal("2.0");
        chai.expect(parsedPayload.result).to.equal(true);
        console.log("Test passing for 3");
      });

      await chai.expect(conn1.send(RPCpayload1)).to.be.fulfilled;
      await chai.expect(conn2.send(RPCpayload2)).to.be.fulfilled;
      await chai.expect(conn3.send(RPCpayload3)).to.be.fulfilled;

      // eslint-disable-next-line promise/param-names
      await new Promise(r => setTimeout(r, 3000));


      await conn1.close();
      await conn2.close();
      await conn3.close();
      // conn1.terminateClient();
      // conn2.terminateClient();
      // conn3.terminateClient();
      SP.terminateServiceProvider();

      // eslint-disable-next-line promise/param-names
      // await new Promise(r => setTimeout(r, 3000));
    });
  });
});
