import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment, x402Client, x402HTTPClient } from "@x402/fetch";
import { config } from "dotenv";
import { privateKeyToAccount } from "viem/accounts";

config();

console.log("Starting x402 fetch client example...");

const baseURL = process.env.RESOURCE_SERVER_URL || "http://localhost:4021";
const endpointPath = process.env.ENDPOINT_PATH || "/weather";
const url = `${baseURL}${endpointPath}`;

function normalizeEvmPrivateKey(value: string | undefined): `0x${string}` {
  if (!value) {
    throw new Error("EVM_PRIVATE_KEY is required");
  }

  const trimmed = value.trim();
  const withPrefix = trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
  const hexBody = withPrefix.slice(2);

  if (!/^[0-9a-fA-F]{64}$/.test(hexBody)) {
    throw new Error(
      "Invalid EVM_PRIVATE_KEY. Expected 32-byte hex (64 chars), with or without 0x prefix.",
    );
  }

  return withPrefix as `0x${string}`;
}

/**
 * Example demonstrating how to use @x402/fetch to make requests to x402-protected endpoints.
 *
 * Uses the builder pattern to register payment schemes directly.
 *
 * Required environment variables:
 * - EVM_PRIVATE_KEY: The private key of the EVM signer
 * - SVM_PRIVATE_KEY: The private key of the SVM signer
 */
async function main(): Promise<void> {
  const evmPrivateKey = normalizeEvmPrivateKey(process.env.EVM_PRIVATE_KEY);
  const evmSigner = privateKeyToAccount(evmPrivateKey);

  const client = new x402Client();
  client.register("eip155:*", new ExactEvmScheme(evmSigner));

  const fetchWithPayment = wrapFetchWithPayment(fetch, client);

  console.log(`Making request to: ${url}\n`);
  const response = await fetchWithPayment(url, { method: "GET" });
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json")
    ? await response.json()
    : await response.text();
  console.log("Response body:", body);

  const paymentResponse = new x402HTTPClient(client).getPaymentSettleResponse(name =>
    response.headers.get(name),
  );
  console.log("\nPayment response:", JSON.stringify(paymentResponse, null, 2));
}

main().catch(error => {
  console.error(error?.response?.data?.error ?? error);
  process.exit(1);
});
