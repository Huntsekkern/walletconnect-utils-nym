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
const preferredGatewayIdentityKey = 'E3mvZTHQCdBvhfr178Swx9g4QG3kkRUun7YnToLMcMbM';

export class WsConnection implements IJsonRpcConnection {
  // TODO check the eventEmitter too. While not directly leaking, even printing things to the console may want to be minimised?
  public events = new EventEmitter();

  private registering = false;

  private nym: NymMixnetClient | undefined;

  // TODO create here or in onOpen??
  private senderTag = crypto.randomBytes(32).toString("hex");
  //private senderTag = crypto.randomBytes(32).toString("base64");

  constructor(public url: string) {
    // TODO: add the nym SP addr?
    if (!isWsUrl(url)) {
      throw new Error(`Provided URL is not compatible with WebSocket connection: ${url}`);
    }
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

      // This must match my mini-protocol as a close order for the SP.

      this.nymSend('close').catch(
        e => console.log("failed to send the request to close a WSConn: " || e)
      );

      // TODO By doing it like that, I'm not waiting for the SP confirming the closure.
      // Could consider playing with events and the onPayload handler to properly wait.
      this.onClose();
      resolve();
    });
  }

  public async send(payload: JsonRpcPayload, context?: any): Promise<void> {
    try  {
      await this.nymSend(safeJsonStringify(payload))
    } catch (e) {
      this.onError(payload.id, e as Error);
    }
  }

  // ---------- Private ----------------------------------------------- //

  // nymSend wraps nym.client.send() to reduce code redundancy.
  private async nymSend(payload: string): Promise<void> {
    if (typeof this.nym === "undefined") {
      this.nym = await this.register();
    }

    const nymPayload: Payload  = {
      message: payload,
    };
    const recipient = '<< SERVICE PROVIDER ADDRESS GOES HERE >>'; // TODO. fix it or user-defined like the url param??
    const SURBsGiven: number = 5;
    await this.nym.client.send({ payload: nymPayload, recipient: recipient, replySurbs: SURBsGiven });
  }


  private async register(url: string = this.url): Promise<NymMixnetClient> {
    this.url = url;
    this.registering = true;

    const nym = await createNymMixnetClient();

    // add nym client to the Window globally, so that it can be used from the dev tools console
    (window as any).nym = nym;

    if (!nym) {
      console.error('Oh no! Could not create client');
      return nym;
    }


    // start the client and connect to a gateway
    await nym.client.start({
      clientId: 'My awesome client',  // TODO HERE
      nymApiUrl,
      preferredGatewayIdentityKey, // TODO HERE
    });

    this.onOpen(nym)

    return nym;
  }

  private onOpen(nym: NymMixnetClient) {
    // show message payload content when received
    // TODO might want to subscribe to all types of message? raw and binary too?
    nym.events.subscribeToTextMessageReceivedEvent((e) => {
      // or nym.onmessage ???
      //console.log('Got a message: ', e.args.payload);
      this.onPayload(e)
    });
    this.nym = nym;
    //this.senderTag =

    // send the "senderTag" now
    // If using send, important to be after the this.nym = nym;
    // and then as well that payload is 'open' as a chosen way to state "please open a conn"
    const payload = {

    }
    this.nymSend('open:' + this.url).catch(
      e => console.log("failed to send the request to open a WSConn: " || e)
    );

    this.registering = false;
    this.events.emit("open");
  }

  private onClose() {
    this.nym = undefined;
    this.registering = false;
    this.events.emit("close", event);
  }

  private onPayload(e: StringMessageReceivedEvent) {
    if (typeof e.args.payload === "undefined") return;
    // const payload: JsonRpcPayload = typeof e.args.payload === "string" ? safeJsonParse(e.args.payload) : e.args.payload;
    const payload: string = e.args.payload;

    if (payload == 'closed') {
      this.onClose()
    } else {
      this.events.emit("payload", payload);
    }

    // This does the regular WC ws job, but with the payload of the nym message instead of the ws connection
    // TODO maybe? process the payload if I give it a different structure at the SP, i.e., like I'm doing with the senderTag
    // also, we could imagine socket.onclose/onerror being passed as message, so we should distinguish them here and process them accordingly.
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
