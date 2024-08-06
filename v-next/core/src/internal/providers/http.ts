import type {
  EIP1193Provider,
  RequestArguments,
} from "../../types/providers.js";
import type {
  JsonRpcResponse,
  JsonRpcRequest,
  SuccessfulJsonRpcResponse,
} from "../utils/json-rpc.js";
import type {
  Dispatcher,
  RequestOptions,
} from "@ignored/hardhat-vnext-utils/request";

import EventEmitter from "node:events";

import { HardhatError } from "@ignored/hardhat-vnext-errors";
import { delay, isObject } from "@ignored/hardhat-vnext-utils/lang";
import {
  getDispatcher,
  isValidUrl,
  postJsonRequest,
  shouldUseProxy,
  ConnectionRefusedError,
  RequestTimeoutError,
  ResponseStatusCodeError,
} from "@ignored/hardhat-vnext-utils/request";

import {
  getJsonRpcRequest,
  isFailedJsonRpcResponse,
  parseJsonRpcResponse,
} from "../utils/json-rpc.js";
import { getHardhatVersion } from "../utils/package.js";

import { ProviderError, ProviderErrorCode } from "./errors.js";

const TOO_MANY_REQUEST_STATUS = 429;
const MAX_RETRIES = 6;
const MAX_RETRY_WAIT_TIME_SECONDS = 5;

export class HttpProvider extends EventEmitter implements EIP1193Provider {
  readonly #url: string;
  readonly #networkName: string;
  readonly #extraHeaders: Record<string, string>;
  readonly #dispatcher: Dispatcher;
  #nextRequestId = 1;

  /**
   * Creates a new instance of `HttpProvider`.
   *
   * @param url
   * @param networkName
   * @param extraHeaders
   * @param timeout
   * @returns
   */
  public static async create(
    url: string,
    networkName: string,
    extraHeaders: Record<string, string> = {},
    timeout?: number,
  ): Promise<HttpProvider> {
    if (!isValidUrl(url)) {
      throw new HardhatError(HardhatError.ERRORS.NETWORK.INVALID_URL, {
        value: url,
      });
    }

    const dispatcher = await getHttpDispatcher(url, timeout);

    const httpProvider = new HttpProvider(
      url,
      networkName,
      extraHeaders,
      dispatcher,
    );

    return httpProvider;
  }

  /**
   * @private
   *
   * This constructor is intended for internal use only.
   * Use the static method {@link HttpProvider.create} to create an instance of
   * `HttpProvider`.
   */
  constructor(
    url: string,
    networkName: string,
    extraHeaders: Record<string, string>,
    dispatcher: Dispatcher,
  ) {
    super();

    this.#url = url;
    this.#networkName = networkName;
    this.#extraHeaders = extraHeaders;
    this.#dispatcher = dispatcher;
  }

  public async request({ method, params }: RequestArguments): Promise<unknown> {
    const jsonRpcRequest = getJsonRpcRequest(
      this.#nextRequestId++,
      method,
      params,
    );
    const jsonRpcResponse = await this.#fetchJsonRpcResponse(jsonRpcRequest);

    if (isFailedJsonRpcResponse(jsonRpcResponse)) {
      const error = new ProviderError(jsonRpcResponse.error.code);
      error.data = jsonRpcResponse.error.data;

      // eslint-disable-next-line no-restricted-syntax -- allow throwing ProviderError
      throw error;
    }

    return jsonRpcResponse.result;
  }

  public async sendBatch(batch: RequestArguments[]): Promise<unknown[]> {
    const requests = batch.map(({ method, params }) =>
      getJsonRpcRequest(this.#nextRequestId++, method, params),
    );

    const jsonRpcResponses = await this.#fetchJsonRpcResponse(requests);

    const successfulJsonRpcResponses: SuccessfulJsonRpcResponse[] = [];
    for (const response of jsonRpcResponses) {
      if (isFailedJsonRpcResponse(response)) {
        const error = new ProviderError(response.error.code);
        error.data = response.error.data;

        // eslint-disable-next-line no-restricted-syntax -- allow throwing ProviderError
        throw error;
      } else {
        successfulJsonRpcResponses.push(response);
      }
    }

    const sortedResponses = successfulJsonRpcResponses.sort((a, b) =>
      `${a.id}`.localeCompare(`${b.id}`, undefined, { numeric: true }),
    );

    return sortedResponses;
  }

  async #fetchJsonRpcResponse(
    jsonRpcRequest: JsonRpcRequest,
    retryCount?: number,
  ): Promise<JsonRpcResponse>;
  async #fetchJsonRpcResponse(
    jsonRpcRequest: JsonRpcRequest[],
    retryCount?: number,
  ): Promise<JsonRpcResponse[]>;
  async #fetchJsonRpcResponse(
    jsonRpcRequest: JsonRpcRequest | JsonRpcRequest[],
    retryCount?: number,
  ): Promise<JsonRpcResponse | JsonRpcResponse[]>;
  async #fetchJsonRpcResponse(
    jsonRpcRequest: JsonRpcRequest | JsonRpcRequest[],
    retryCount = 0,
  ): Promise<JsonRpcResponse | JsonRpcResponse[]> {
    const requestOptions: RequestOptions = {
      extraHeaders: {
        "User-Agent": `Hardhat ${await getHardhatVersion()}`,
        ...this.#extraHeaders,
      },
    };

    let response;
    try {
      response = await postJsonRequest(
        this.#url,
        jsonRpcRequest,
        requestOptions,
        this.#dispatcher,
      );
    } catch (e) {
      if (e instanceof ConnectionRefusedError) {
        throw new HardhatError(
          HardhatError.ERRORS.NETWORK.CONNECTION_REFUSED,
          { network: this.#networkName },
          e,
        );
      }

      if (e instanceof RequestTimeoutError) {
        throw new HardhatError(HardhatError.ERRORS.NETWORK.NETWORK_TIMEOUT, e);
      }

      /**
       * Nodes can have a rate limit mechanism to avoid abuse. This logic checks
       * if the response indicates a rate limit has been reached and retries the
       * request after the specified time.
       */
      if (
        e instanceof ResponseStatusCodeError &&
        e.statusCode === TOO_MANY_REQUEST_STATUS
      ) {
        const retryAfterHeader =
          isObject(e.headers) && typeof e.headers["retry-after"] === "string"
            ? e.headers["retry-after"]
            : undefined;
        const retryAfterSeconds = this.#getRetryAfterSeconds(
          retryAfterHeader,
          retryCount,
        );
        if (this.#shouldRetryRequest(retryAfterSeconds, retryCount)) {
          return this.#retry(jsonRpcRequest, retryAfterSeconds, retryCount);
        }

        const error = new ProviderError(ProviderErrorCode.LIMIT_EXCEEDED);
        error.data = {
          hostname: new URL(this.#url).hostname,
          retryAfterSeconds,
        };

        // eslint-disable-next-line no-restricted-syntax -- allow throwing ProviderError
        throw error;
      }

      throw e;
    }

    return parseJsonRpcResponse(await response.body.text());
  }

  #getRetryAfterSeconds(
    retryAfterHeader: string | undefined,
    retryCount: number,
  ) {
    const parsedRetryAfter = parseInt(`${retryAfterHeader}`, 10);
    if (isNaN(parsedRetryAfter)) {
      // use an exponential backoff if the retry-after header can't be parsed
      return Math.min(2 ** retryCount, MAX_RETRY_WAIT_TIME_SECONDS);
    }

    return parsedRetryAfter;
  }

  #shouldRetryRequest(retryAfterSeconds: number, retryCount: number) {
    if (retryCount > MAX_RETRIES) {
      return false;
    }

    if (retryAfterSeconds > MAX_RETRY_WAIT_TIME_SECONDS) {
      return false;
    }

    return true;
  }

  async #retry(
    request: JsonRpcRequest | JsonRpcRequest[],
    retryAfterSeconds: number,
    retryCount: number,
  ) {
    await delay(retryAfterSeconds);
    return this.#fetchJsonRpcResponse(request, retryCount + 1);
  }
}

/**
 * Gets either a pool or proxy dispatcher depending on the URL and the
 * environment variable `http_proxy`. This function is used internally by
 * `HttpProvider.create` and should not be used directly.
 */
export async function getHttpDispatcher(
  url: string,
  timeout?: number,
): Promise<Dispatcher> {
  let dispatcher: Dispatcher;

  if (process.env.http_proxy !== undefined && shouldUseProxy(url)) {
    dispatcher = await getDispatcher(url, {
      proxy: process.env.http_proxy,
      timeout,
    });
  } else {
    dispatcher = await getDispatcher(url, { pool: true, timeout });
  }

  return dispatcher;
}
