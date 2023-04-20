import { EventEmitter } from "events";
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
import { createNymMixnetClient, NymMixnetClient, Payload, StringMessageReceivedEvent } from "@nymproject/sdk";

// Source: https://nodejs.org/api/events.html#emittersetmaxlistenersn
import crypto from "crypto";

const EVENT_EMITTER_MAX_LISTENERS_DEFAULT = 10;


const isBrowser = () => typeof window !== "undefined";

const nymApiUrl = 'https://validator.nymtech.net/api';

export class WsConnection implements IJsonRpcConnection {
  // TODO check the eventEmitter too. While not directly leaking, even printing things to the console may want to be minimised?
  public events = new EventEmitter();

  // TODO maybe HERE, or at least check all methods calling it!
  // A nice solution could be to create a wrapper around the WebSocket instead of wrapping the calls individually.
  // I should wrap at least close, send

  private registering = false;

  private nym: NymMixnetClient | undefined;

  // TODO create here or in onOpen??
  private senderTag = crypto.randomBytes(32).toString("hex");
  //private senderTag = crypto.randomBytes(32).toString("base64");

  constructor(public url: string) {
    // TODO: currently, url is the relay ws url. Should I let the service provider choose it and reconvert the url to the nym address of the SP?
    // Or should I keep both the ws url and the nym SP addr?
    this.url = url;
  }

  get connected(): boolean {
    return typeof this.nym !== "undefined";
  }

  get connecting(): boolean {
    return this.registering;
  }

  public on(event: string, listener: any): void {
    this.events.on(event, listener);
  }

  public once(event: string, listener: any): void {
    this.events.once(event, listener);
  }

  public off(event: string, listener: any): void {
    this.events.off(event, listener);
  }

  public removeListener(event: string, listener: any): void {
    this.events.removeListener(event, listener);
  }

  public async open(url: string = this.url): Promise<void> {
    await this.register(url)
  }

  public async close(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (typeof this.nym === "undefined") {
        reject(new Error("Connection already closed"));
        return;
      }

      this.nym.onclose = event => {
        this.onClose(event);
        resolve();
      };

      // TODO HERE
      this.nym.close();
    });
  }

  public async send(payload: JsonRpcPayload, context?: any): Promise<void> {
    if (typeof this.nym === "undefined") {
      this.nym = await this.register();
    }
    try {
      // TODO HERE
      // send takes several options, but in this case a string. This indicates again that this is only the payload,
      // and either I modify the send function/WS class to take a fixed url, or I modify the url being passed as an arg from a higher level.
      // But changing the url to the gateway is not enough! I need to call nym SDK which is a send too instead.

      // Adding the senderTag here would follow the DRY rule a bit more. Yeah, that's the solution
      const taggedPayload = {
        senderTag: this.senderTag,
        payload: safeJsonStringify(payload)
      }
      const nymPayload: Payload  = {
        message: safeJsonStringify(taggedPayload),
      };
      const recipient = '<< SERVICE PROVIDER ADDRESS GOES HERE >>'; // TODO
      const SURBsGiven: number = 5;
      await this.nym.client.send({ payload: nymPayload, recipient: recipient, replySurbs: SURBsGiven });
    } catch (e) {
      this.onError(payload.id, e as Error);
    }
  }

  // ---------- Private ----------------------------------------------- //

  private async register(url: string = this.url): Promise<NymMixnetClient> {
    this.url = url;
    this.registering = true;

    const nym = await createNymMixnetClient();

    // start the client and connect to a gateway
    await nym.client.start({
      clientId: 'My awesome client',  // TODO HERE
      nymApiUrl,
    });

    this.onOpen(nym)

    return nym;
  }

  private onOpen(nym: NymMixnetClient) {
    // show message payload content when received
    nym.events.subscribeToTextMessageReceivedEvent((e) => {
      //console.log('Got a message: ', e.args.payload);
      this.onPayload(e)
    });
    this.nym = nym;
    //this.senderTag =

    // send the "senderTag" now
    // If using send, important to be after the this.nym = nym;
    // and then as well that payload is '' as a chosen way to state "please open a conn"
    this.send('').catch(
      e => console.log("failed to send the request to open a WSConn: " || e)
    );

    this.registering = false;
    this.events.emit("open");
  }

  private onClose(event: CloseEvent) {
    this.nym = undefined;
    this.registering = false;
    this.events.emit("close", event);
  }

  private onPayload(e: StringMessageReceivedEvent) {
    if (typeof e.args.payload === "undefined") return;
    const payload: JsonRpcPayload = typeof e.args.payload === "string" ? safeJsonParse(e.args.payload) : e.args.payload;
    // This does the regular WC ws job, but with the payload of the nym message instead of the ws connection
    // TODO maybe? process the payload if I give it a different structure at the SP, i.e., like I'm doing with the senderTag
    // also, we could imagine socket.onclose/onerror being passed as message, so we should distinguish them here and process them accordingly.
    this.events.emit("payload", payload);
  }

  private onError(id: number, e: Error) {
    const error = this.parseError(e);
    const message = error.message || error.toString();
    const payload = formatJsonRpcError(id, message);
    this.events.emit("payload", payload);
  }

  private parseError(e: Error, url = this.url) {
    return parseConnectionError(e, url, "WS");
  }

  private resetMaxListeners() {
    if (this.events.getMaxListeners() > EVENT_EMITTER_MAX_LISTENERS_DEFAULT) {
      this.events.setMaxListeners(EVENT_EMITTER_MAX_LISTENERS_DEFAULT);
    }
  }

}

export default WsConnection;
