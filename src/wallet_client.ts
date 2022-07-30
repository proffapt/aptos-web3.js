import { Buffer } from "buffer/";
import * as bip39 from "@scure/bip39";
import * as english from "@scure/bip39/wordlists/english";
import fetch from "cross-fetch";
import assert from "assert";
import { AptosAccount } from "./aptos_account";
import { TokenClient } from "./token_client";
import { AptosClient } from "./aptos_client";
import { FaucetClient } from "./faucet_client";
import { HexString, MaybeHexString } from "./hex_string";
import { Types } from "./types";
import { RawTransaction } from "./transaction_builder/aptos_types/transaction";
import cache from "./utils/cache";

const { HDKey } = require("@scure/bip32");

const COIN_TYPE = 637;
const MAX_ACCOUNTS = 5;
const ADDRESS_GAP = 10;

export interface TokenId {
  creator: string;
  collectionName: string;
  name: string;
}

export interface AccountMetaData {
  derivationPath: string;
  address: string;
  publicKey?: string;
}

export interface Wallet {
  code: string; // mnemonic
  accounts: AccountMetaData[];
}

export class WalletClient {
  faucetClient: FaucetClient;

  aptosClient: AptosClient;

  tokenClient: TokenClient;

  constructor(node_url, faucet_url) {
    this.faucetClient = new FaucetClient(node_url, faucet_url);
    this.aptosClient = new AptosClient(node_url);
    this.tokenClient = new TokenClient(this.aptosClient);
  }

  /**
   * Each mnemonic phrase corresponds to a single wallet
   * Wallet can contain multiple accounts
   * An account corresponds to a key pair + address
   *
   * Get all the accounts of a user from their mnemonic phrase
   *
   * @param code The mnemonic phrase (12 word)
   * @returns Wallet object containing all accounts of a user
   */
  async importWallet(code: string): Promise<Wallet> {
    let flag = false;
    let address = "";
    let publicKey = "";
    let derivationPath = "";
    let authKey = "";

    if (!bip39.validateMnemonic(code, english.wordlist)) {
      return Promise.reject(new Error("Incorrect mnemonic passed"));
    }
    const seed: Uint8Array = bip39.mnemonicToSeedSync(code.toString());
    const node = HDKey.fromMasterSeed(Buffer.from(seed));
    const accountMetaData: AccountMetaData[] = [];
    for (let i = 0; i < MAX_ACCOUNTS; i += 1) {
      flag = false;
      address = "";
      publicKey = "";
      derivationPath = "";
      authKey = "";
      for (let j = 0; j < ADDRESS_GAP; j += 1) {
        /* eslint-disable no-await-in-loop */
        const exKey = node.derive(`m/44'/${COIN_TYPE}'/${i}'/0/${j}`);
        let acc: AptosAccount = new AptosAccount(exKey.privateKey);
        if (j === 0) {
          address = acc.authKey().toString();
          publicKey = acc.pubKey().toString();
          const response = await fetch(
            `${this.aptosClient.nodeUrl}/accounts/${address}`,
            {
              method: "GET",
            }
          );
          if (response.status === 404) {
            break;
          }
          const respBody = await response.json();
          authKey = respBody.authentication_key;
        }
        acc = new AptosAccount(exKey.privateKey, address);
        if (acc.authKey().toString() === authKey) {
          flag = true;
          derivationPath = `m/44'/${COIN_TYPE}'/${i}'/0/${j}`;
          break;
        }
        /* eslint-enable no-await-in-loop */
      }
      if (!flag) {
        break;
      }
      accountMetaData.push({
        derivationPath,
        address,
        publicKey,
      });
    }
    return { code, accounts: accountMetaData };
  }

  /**
   * Creates a new wallet which contains a single account,
   * which is registered on Aptos
   *
   * @returns A wallet object
   */
  async createWallet(): Promise<Wallet> {
    const code = bip39.generateMnemonic(english.wordlist); // mnemonic
    const accountMetadata = await this.createNewAccount(code);
    return { code, accounts: [accountMetadata] };
  }

  /**
   * Creates a new account in the provided wallet
   *
   * @param code mnemonic phrase of the wallet
   * @returns
   */
  async createNewAccount(code: string): Promise<AccountMetaData> {
    const seed: Uint8Array = bip39.mnemonicToSeedSync(code.toString());
    const node = HDKey.fromMasterSeed(Buffer.from(seed));
    for (let i = 0; i < MAX_ACCOUNTS; i += 1) {
      /* eslint-disable no-await-in-loop */
      const derivationPath = `m/44'/${COIN_TYPE}'/${i}'/0/0`;
      const exKey = node.derive(derivationPath);
      const acc: AptosAccount = new AptosAccount(exKey.privateKey);
      const address = acc.authKey().toString();
      const response = await fetch(
        `${this.aptosClient.nodeUrl}/accounts/${address}`,
        {
          method: "GET",
        }
      );
      if (response.status === 404) {
        await this.faucetClient.fundAccount(acc.authKey(), 0);
        return {
          derivationPath,
          address,
          publicKey: acc.pubKey().toString(),
        };
      }
      /* eslint-enable no-await-in-loop */
    }
    throw new Error("Max no. of accounts reached");
  }

  /**
   * returns an AptosAccount object given a private key and
   * address of the account
   *
   * @param privateKey Private key of an account as a Buffer
   * @param address address of a user
   * @returns AptosAccount object
   */
  static getAccountFromPrivateKey(privateKey: Buffer, address?: string) {
    return new AptosAccount(privateKey, address);
  }

  /**
   * returns an AptosAccount at position m/44'/COIN_TYPE'/0'/0/0
   *
   * @param code mnemonic phrase of the wallet
   * @returns AptosAccount object
   */
  static getAccountFromMnemonic(code: string) {
    const seed: Uint8Array = bip39.mnemonicToSeedSync(code.toString());
    const node = HDKey.fromMasterSeed(Buffer.from(seed));
    const exKey = node.derive(`m/44'/${COIN_TYPE}'/0'/0/0`);
    return new AptosAccount(exKey.privateKey);
  }

  /**
   * returns an AptosAccount object for the desired account
   * using the metadata of the account
   *
   * @param code mnemonic phrase of the wallet
   * @param metaData metadata of the account to be fetched
   * @returns
   */
  static getAccountFromMetaData(code: string, metaData: AccountMetaData) {
    const seed: Uint8Array = bip39.mnemonicToSeedSync(code.toString());
    const node = HDKey.fromMasterSeed(Buffer.from(seed));
    const exKey = node.derive(metaData.derivationPath);
    return new AptosAccount(exKey.privateKey, metaData.address);
  }

  /**
   * airdrops test coins in the given account
   *
   * @param address address of the receiver's account
   * @param amount amount to be airdropped
   * @returns list of transaction hashs
   */
  async airdrop(address: string, amount: number) {
    return Promise.resolve(
      await this.faucetClient.fundAccount(address, amount)
    );
  }

  /**
   * returns the balance of the said account
   *
   * @param address address of the desired account
   * @returns balance of the account
   */
  async getBalance(address: string | HexString) {
    let balance = 0;
    const resources: any = await this.aptosClient.getAccountResources(address);
    Object.values(resources).forEach((value: any) => {
      if (value.type === "0x1::coin::CoinStore<0x1::test_coin::TestCoin>") {
        balance = Number(value.data.coin.value);
      }
    });
    return Promise.resolve(balance);
  }

  /**
   * returns the list of on-chain transactions sent by the said account
   *
   * @param accountAddress address of the desired account
   * @returns list of transactions
   */
  async accountTransactions(accountAddress: MaybeHexString) {
    const data = await this.aptosClient.getAccountTransactions(accountAddress);
    const transactions = data.map((item: any) => ({
      data: item.payload,
      from: item.sender,
      gas: item.gas_used,
      gasPrice: item.gas_unit_price,
      hash: item.hash,
      success: item.success,
      timestamp: item.timestamp,
      toAddress: item.payload.arguments[0],
      price: item.payload.arguments[1],
      type: item.type,
      version: item.version,
      vmStatus: item.vm_status,
    }));
    return transactions;
  }

  /**
   * transfers Aptos Coins from signer to receiver
   *
   * @param account AptosAccount object of the signing account
   * @param recipient_address address of the receiver account
   * @param amount amount of aptos coins to be transferred
   * @returns transaction hash
   */
  async transfer(
    account: AptosAccount,
    recipient_address: string | HexString,
    amount: number
  ) {
    try {
      if (recipient_address.toString() === account.address().toString()) {
        return new Error("cannot transfer coins to self");
      }

      const payload: {
        function: string;
        arguments: string[];
        type: string;
        type_arguments: any[];
      } = {
        type: "script_function_payload",
        function: "0x1::coin::transfer",
        type_arguments: ["0x1::test_coin::TestCoin"],

        arguments: [
          `${HexString.ensure(recipient_address)}`,
          amount.toString(),
        ],
      };

      return await this.tokenClient.submitTransactionHelper(account, payload);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  /**
   * returns the list of events involving transactions
   * starting from the said account
   *
   * @param address address of the desired account
   * @returns list of events
   */
  async getSentEvents(address: MaybeHexString) {
    return Promise.resolve(
      await this.aptosClient.getAccountTransactions(address)
    );
  }

  /**
   * returns the list of events involving transactions of Aptos Coins
   * received by the said account
   *
   * @param address address of the desired account
   * @returns list of events
   */
  async getReceivedEvents(address: string) {
    return Promise.resolve(
      await this.aptosClient.getEventsByEventHandle(
        address,
        "0x1::coin::CoinStore<0x1::test_coin::TestCoin>",
        "deposit_events"
      )
    );
  }

  /**
   * creates an NFT collection
   *
   * @param account AptosAccount object of the signing account
   * @param name collection name
   * @param description collection description
   * @param uri collection URI
   * @returns transaction hash
   */
  async createCollection(
    account: AptosAccount,
    name: string,
    description: string,
    uri: string
  ) {
    return Promise.resolve(
      await this.tokenClient.createCollection(account, name, description, uri)
    );
  }

  /**
   * creates an NFT
   *
   * @param account AptosAccount object of the signing account
   * @param collection_name collection name
   * @param name NFT name
   * @param description NFT description
   * @param supply supply for the NFT
   * @param uri NFT URI
   * @param royalty_points_per_million royalty points per million
   * @returns transaction hash
   */
  async createToken(
    account: AptosAccount,
    collection_name: string,
    name: string,
    description: string,
    supply: number,
    uri: string,
    royalty_points_per_million: number = 0
  ) {
    return Promise.resolve(
      await this.tokenClient.createToken(
        account,
        collection_name,
        name,
        description,
        supply,
        uri,
        royalty_points_per_million
      )
    );
  }

  /**
   * offers an NFT to another account
   *
   * @param account AptosAccount object of the signing account
   * @param receiver_address address of the receiver account
   * @param creator_address address of the creator account
   * @param collection_name collection name
   * @param token_name NFT name
   * @param amount amount to receive while offering the token
   * @returns transaction hash
   */
  async offerToken(
    account: AptosAccount,
    receiver_address: string,
    creator_address: string,
    collection_name: string,
    token_name: string,
    amount: number
  ) {
    return Promise.resolve(
      await this.tokenClient.offerToken(
        account,
        receiver_address,
        creator_address,
        collection_name,
        token_name,
        amount
      )
    );
  }

  /**
   * cancels an NFT offer
   *
   * @param account AptosAccount of the signing account
   * @param receiver_address address of the receiver account
   * @param creator_address address of the creator account
   * @param collection_name collection name
   * @param token_name NFT name
   * @returns transaction hash
   */
  async cancelTokenOffer(
    account: AptosAccount,
    receiver_address: string,
    creator_address: string,
    collection_name: string,
    token_name: string
  ) {
    return Promise.resolve(
      await this.tokenClient.cancelTokenOffer(
        account,
        receiver_address,
        creator_address,
        collection_name,
        token_name
      )
    );
  }

  /**
   * claims offered NFT
   *
   * @param account AptosAccount of the signing account
   * @param sender_address address of the sender account
   * @param creator_address address of the creator account
   * @param collection_name collection name
   * @param token_name NFT name
   * @returns transaction hash
   */
  async claimToken(
    account: AptosAccount,
    sender_address: string,
    creator_address: string,
    collection_name: string,
    token_name: string
  ) {
    return Promise.resolve(
      await this.tokenClient.claimToken(
        account,
        sender_address,
        creator_address,
        collection_name,
        token_name
      )
    );
  }

  /**
   * sign a generic transaction
   *
   * @param account AptosAccount of the signing account
   * @param func function name to be called
   * @param args arguments of the function to be called
   * @param type_args type arguments of the function to be called
   * @returns transaction hash
   */
  async signGenericTransaction(
    account: AptosAccount,
    func: string,
    args: string[],
    type_args: string[]
  ) {
    const payload: {
      function: string;
      arguments: string[];
      type: string;
      type_arguments: any[];
    } = {
      type: "script_function_payload",
      function: func,
      type_arguments: type_args,
      arguments: args,
    };

    const txnHash = await this.tokenClient.submitTransactionHelper(
      account,
      payload
    );

    const resp: any = await this.aptosClient.getTransaction(txnHash);
    const status = { success: resp.success, vm_status: resp.vm_status };

    return { txnHash, ...status };
  }

  async signAndSubmitTransaction(
    account: AptosAccount,
    txnRequest: Types.UserTransactionRequest
  ) {
    const signedTxn = await this.aptosClient.signTransaction(
      account,
      txnRequest
    );
    const res = await this.aptosClient.submitTransaction(signedTxn);
    await this.aptosClient.waitForTransaction(res.hash);
    return Promise.resolve(res.hash);
  }

  // sign and submit multiple transactions
  async signAndSubmitTransactions(
    account: AptosAccount,
    txnRequests: Types.UserTransactionRequest[]
  ) {
    const hashs = [];
    // eslint-disable-next-line no-restricted-syntax
    for (const txnRequest of txnRequests) {
      /* eslint-disable no-await-in-loop */
      try {
        txnRequest.sequence_number = (
          await this.aptosClient.getAccount(account.address().toString())
        ).sequence_number;
        const signedTxn = await this.aptosClient.signTransaction(
          account,
          txnRequest
        );
        const res = await this.aptosClient.submitTransaction(signedTxn);
        await this.aptosClient.waitForTransaction(res.hash);
        hashs.push(res.hash);
      } catch (err) {
        hashs.push(err.message);
      }
      /* eslint-enable no-await-in-loop */
    }
    return Promise.resolve(hashs);
  }

  async signTransaction(
    account: AptosAccount,
    txnRequest: Types.UserTransactionRequest
  ): Promise<Types.SubmitTransactionRequest> {
    return Promise.resolve(
      await this.aptosClient.signTransaction(account, txnRequest)
    );
  }

  async estimateGasFees(
    account: AptosAccount,
    transaction: Types.UserTransactionRequest
  ): Promise<string> {
    const simulateResponse: Types.OnChainTransaction =
      await this.aptosClient.simulateTransaction(account, transaction);
    return simulateResponse.gas_used;
  }

  async submitTransaction(signedTxn: Types.SubmitTransactionRequest) {
    return Promise.resolve(await this.aptosClient.submitTransaction(signedTxn));
  }

  static generateBCSTransaction(
    account: AptosAccount,
    rawTxn: RawTransaction
  ): Promise<Uint8Array> {
    return Promise.resolve(AptosClient.generateBCSTransaction(account, rawTxn));
  }

  static generateBCSSimulation(
    account: AptosAccount,
    rawTxn: RawTransaction
  ): Promise<Uint8Array> {
    return Promise.resolve(AptosClient.generateBCSSimulation(account, rawTxn));
  }

  async submitSignedBCSTransaction(
    signedTxn: Uint8Array
  ): Promise<Types.PendingTransaction> {
    return Promise.resolve(
      await this.aptosClient.submitSignedBCSTransaction(signedTxn)
    );
  }

  async submitBCSSimulation(
    bcsBody: Uint8Array
  ): Promise<Types.OnChainTransaction> {
    return Promise.resolve(await this.aptosClient.submitBCSSimulation(bcsBody));
  }

  static signMessage(account: AptosAccount, message: string): Promise<string> {
    return Promise.resolve(account.signBuffer(Buffer.from(message)).hex());
  }

  /**
   * Rotates the auth key
   *
   * @param code mnemonic phrase for the desired wallet
   * @param metaData metadata for the desired account
   * @returns status object
   */
  async rotateAuthKey(code: string, metaData: AccountMetaData) {
    const account: AptosAccount = await WalletClient.getAccountFromMetaData(
      code,
      metaData
    );
    const pathSplit = metaData.derivationPath.split("/");
    const addressIndex = Number(pathSplit[pathSplit.length - 1]);
    if (addressIndex >= ADDRESS_GAP - 1) {
      throw new Error("Maximum key rotation reached");
    }
    const newDerivationPath = `${pathSplit
      .slice(0, pathSplit.length - 1)
      .join("/")}/${addressIndex + 1}`;
    const newAccount = await WalletClient.getAccountFromMetaData(code, {
      address: metaData.address,
      derivationPath: newDerivationPath,
    });
    const newAuthKey = newAccount.authKey().toString().split("0x")[1];
    const transactionStatus = await this.signGenericTransaction(
      account,
      "0x1::account::rotate_authentication_key",
      [newAuthKey],
      []
    );

    if (!transactionStatus.success) {
      return {
        authkey: "",
        success: false,
        vm_status: transactionStatus.vm_status,
      };
    }

    return {
      authkey: `0x${newAuthKey}`,
      success: true,
      vm_status: transactionStatus.vm_status,
    };
  }

  async getEventStream(
    address: string,
    eventHandleStruct: string,
    fieldName: string,
    limit?: number,
    start?: number
  ) {
    let endpointUrl = `${this.aptosClient.nodeUrl}/accounts/${address}/events/${eventHandleStruct}/${fieldName}`;
    if (limit) {
      endpointUrl += `?limit=${limit}`;
    }

    if (start) {
      endpointUrl += limit ? `&start=${start}` : `?start=${start}`;
    }
    const response = await fetch(endpointUrl, {
      method: "GET",
    });

    if (response.status === 404) {
      return [];
    }

    return Promise.resolve(await response.json());
  }

  /**
   * returns a list of token IDs of the tokens in a user's account
   * (including the tokens that were minted)
   *
   * @param address address of the desired account
   * @returns list of token IDs
   */
  async getTokenIds(address: string, limit?: number, start?: number) {
    const countDeposit = {};
    const countWithdraw = {};
    const tokenIds = [];

    const depositEvents = await this.getEventStream(
      address,
      "0x1::token::TokenStore",
      "deposit_events",
      limit,
      start
    );

    const withdrawEvents = await this.getEventStream(
      address,
      "0x1::token::TokenStore",
      "withdraw_events",
      limit,
      start
    );

    depositEvents.forEach((element) => {
      const elementString = JSON.stringify(element.data.id);
      countDeposit[elementString] = countDeposit[elementString]
        ? countDeposit[elementString] + 1
        : 1;
    });

    withdrawEvents.forEach((element) => {
      const elementString = JSON.stringify(element.data.id);
      countWithdraw[elementString] = countWithdraw[elementString]
        ? countWithdraw[elementString] + 1
        : 1;
    });

    depositEvents.forEach((element) => {
      const elementString = JSON.stringify(element.data.id);
      const count1 = countDeposit[elementString];
      const count2 = countWithdraw[elementString]
        ? countWithdraw[elementString]
        : 0;
      if (count1 - count2 === 1) {
        tokenIds.push({
          data: element.data.id,
          sequence_number: element.sequence_number,
        });
      }
    });
    return tokenIds;
  }

  /**
   * returns the tokens in an account
   *
   * @param address address of the desired account
   * @returns list of tokens and their collection data
   */
  async getTokens(address: string, limit?: number, start?: number) {
    const tokenIds = await this.getTokenIds(address, limit, start);
    const tokens = [];
    await Promise.all(
      tokenIds.map(async (tokenId) => {
        let resources: Types.AccountResource[];
        if (cache.has(`resources--${tokenId.data.creator}`)) {
          resources = cache.get(`resources--${tokenId.data.creator}`);
        } else {
          resources = await this.aptosClient.getAccountResources(
            tokenId.data.creator
          );
          cache.set(`resources--${tokenId.data.creator}`, resources);
        }
        const accountResource: { type: string; data: any } = resources.find(
          (r) => r.type === "0x1::token::Collections"
        );
        const tableItemRequest: Types.TableItemRequest = {
          key_type: "0x1::token::TokenId",
          value_type: "0x1::token::TokenData",
          key: tokenId.data,
        };

        const cacheKey = JSON.stringify(tableItemRequest);

        let token: any;
        if (cache.has(cacheKey)) {
          token = cache.get(cacheKey);
        } else {
          token = (
            await this.aptosClient.getTableItem(
              accountResource.data.token_data.handle,
              tableItemRequest
            )
          ).data;
          cache.set(cacheKey, token);
        }
        tokens.push({ token, sequence_number: tokenId.sequence_number });
      })
    );

    return tokens;
  }

  /**
   * returns the token information (including the collection information)
   * about a said tokenID
   *
   * @param tokenId token ID of the desired token
   * @returns token information
   */
  async getToken(tokenId: TokenId) {
    const resources: Types.AccountResource[] =
      await this.aptosClient.getAccountResources(tokenId.creator);
    const accountResource: { type: string; data: any } = resources.find(
      (r) => r.type === "0x1::token::Collections"
    );

    const tableItemRequest: Types.TableItemRequest = {
      key_type: "0x1::token::TokenId",
      value_type: "0x1::token::TokenData",
      key: tokenId,
    };
    const token = (
      await this.aptosClient.getTableItem(
        accountResource.data.token_data.handle,
        tableItemRequest
      )
    ).data;
    return token;
  }

  /**
   * returns the information about a collection of an account
   *
   * @param address address of the desired account
   * @param collectionName collection name
   * @returns collection information
   */
  async getCollection(address: string, collectionName: string) {
    const resources: Types.AccountResource[] =
      await this.aptosClient.getAccountResources(address);
    const accountResource: { type: string; data: any } = resources.find(
      (r) => r.type === "0x1::token::Collections"
    );

    const tableItemRequest: Types.TableItemRequest = {
      key_type: "0x1::string::String",
      value_type: "0x1::token::Collection",
      key: collectionName,
    };
    const collection = (
      await this.aptosClient.getTableItem(
        accountResource.data.collections.handle,
        tableItemRequest
      )
    ).data;
    return collection;
  }

  async getCustomResource(
    address: string,
    resourceType: string,
    fieldName: string,
    keyType: string,
    valueType: string,
    key: any
  ) {
    const resources: Types.AccountResource[] =
      await this.aptosClient.getAccountResources(address);
    const accountResource: { type: string; data: any } = resources.find(
      (r) => r.type === resourceType
    );

    const tableItemRequest: Types.TableItemRequest = {
      key_type: keyType,
      value_type: valueType,
      key,
    };
    const resource = (
      await this.aptosClient.getTableItem(
        accountResource.data[fieldName].handle,
        tableItemRequest
      )
    ).data;
    return resource;
  }

  /**
   * returns info about a particular resource inside an account
   *
   * @param accountAddress address of the desired account
   * @param resourceType type of the desired resource
   * @returns resource information
   */
  async getAccountResource(
    accountAddress: string,
    resourceType: string
  ): Promise<any> {
    const response = await fetch(
      `${this.aptosClient.nodeUrl}/accounts/${accountAddress}/resource/${resourceType}`,
      { method: "GET" }
    );
    if (response.status === 404) {
      return null;
    }
    if (response.status !== 200) {
      assert(response.status === 200, await response.text());
    }
    return Promise.resolve(await response.json());
  }

  /**
   * initializes a coin
   *
   * precondition: a module of the desired coin has to be deployed in the signer's account
   *
   * @param account AptosAccount object of the signing account
   * @param coin_type_path address path of the desired coin
   * @param name name of the coin
   * @param symbol symbol of the coin
   * @param scaling_factor scaling factor of the coin
   * @returns transaction hash
   */
  async initializeCoin(
    account: AptosAccount,
    coin_type_path: string, // coin_type_path: something like 0x${coinTypeAddress}::moon_coin::MoonCoin
    name: string,
    symbol: string,
    scaling_factor: number
  ) {
    const payload: {
      function: string;
      arguments: any[];
      type: string;
      type_arguments: any[];
    } = {
      type: "script_function_payload",
      function: "0x1::managed_coin::initialize",
      type_arguments: [coin_type_path],
      arguments: [
        Buffer.from(name).toString("hex"),
        Buffer.from(symbol).toString("hex"),
        scaling_factor.toString(),
        false,
      ],
    };
    const txnHash = await this.tokenClient.submitTransactionHelper(
      account,
      payload
    );
    const resp: any = await this.aptosClient.getTransaction(txnHash);
    const status = { success: resp.success, vm_status: resp.vm_status };

    return { txnHash, ...status };
  }

  /**
   * registers a coin for an account
   *
   * creates the resource for the desired account such that
   * the account can start transacting in the desired coin
   *
   * @param account AptosAccount object of the signing account
   * @param coin_type_path address path of the desired coin
   * @returns transaction hash
   */
  async registerCoin(account: AptosAccount, coin_type_path: string) {
    // coin_type_path: something like 0x${coinTypeAddress}::moon_coin::MoonCoin
    const payload: {
      function: string;
      arguments: any[];
      type: string;
      type_arguments: any[];
    } = {
      type: "script_function_payload",
      function: "0x1::coin::register",
      type_arguments: [coin_type_path],
      arguments: [],
    };

    const txnHash = await this.tokenClient.submitTransactionHelper(
      account,
      payload
    );
    const resp: any = await this.aptosClient.getTransaction(txnHash);
    const status = { success: resp.success, vm_status: resp.vm_status };

    return { txnHash, ...status };
  }

  /**
   * mints a coin in a receiver account
   *
   * precondition: the signer should have minting capability
   * unless specifically granted, only the account where the module
   * of the desired coin lies has the minting capability
   *
   * @param account AptosAccount object of the signing account
   * @param coin_type_path address path of the desired coin
   * @param dst_address address of the receiver account
   * @param amount amount to be minted
   * @returns transaction hash
   */
  async mintCoin(
    account: AptosAccount,
    coin_type_path: string, // coin_type_path: something like 0x${coinTypeAddress}::moon_coin::MoonCoin
    dst_address: string,
    amount: number
  ) {
    const payload: {
      function: string;
      arguments: any[];
      type: string;
      type_arguments: any[];
    } = {
      type: "script_function_payload",
      function: "0x1::managed_coin::mint",
      type_arguments: [coin_type_path],
      arguments: [dst_address.toString(), amount.toString()],
    };
    const txnHash = await this.tokenClient.submitTransactionHelper(
      account,
      payload
    );
    const resp: any = await this.aptosClient.getTransaction(txnHash);
    const status = { success: resp.success, vm_status: resp.vm_status };

    return { txnHash, ...status };
  }

  /**
   * transfers coin (applicable for all altcoins on Aptos) to receiver account
   *
   * @param account AptosAccount object of the signing account
   * @param coin_type_path address path of the desired coin
   * @param to_address address of the receiver account
   * @param amount amount to be transferred
   * @returns transaction hash
   */
  async transferCoin(
    account: AptosAccount,
    coin_type_path: string, // coin_type_path: something like 0x${coinTypeAddress}::moon_coin::MoonCoin
    to_address: string,
    amount: number
  ) {
    const payload: {
      function: string;
      arguments: any[];
      type: string;
      type_arguments: any[];
    } = {
      type: "script_function_payload",
      function: "0x1::coin::transfer",
      type_arguments: [coin_type_path],
      arguments: [to_address.toString(), amount.toString()],
    };
    const txnHash = await this.tokenClient.submitTransactionHelper(
      account,
      payload
    );
    const resp: any = await this.aptosClient.getTransaction(txnHash);
    const status = { success: resp.success, vm_status: resp.vm_status };

    return { txnHash, ...status };
  }

  /**
   * returns the information about the coin
   *
   * @param coin_type_path address path of the desired coin
   * @returns coin information
   */
  async getCoinData(coin_type_path: string) {
    const coinData = await this.getAccountResource(
      coin_type_path.split("::")[0],
      `0x1::coin::CoinInfo<${coin_type_path}>`
    );
    return coinData;
  }

  /**
   * returns the balance of the coin for an account
   *
   * @param address address of the desired account
   * @param coin_type_path address path of the desired coin
   * @returns number of coins
   */
  async getCoinBalance(
    address: string,
    coin_type_path: string
  ): Promise<number> {
    // coin_type_path: something like 0x${coinTypeAddress}::moon_coin::MoonCoin
    const coinInfo = await this.getAccountResource(
      address,
      `0x1::coin::CoinStore<${coin_type_path}>`
    );
    return Number(coinInfo.data.coin.value);
  }
}
