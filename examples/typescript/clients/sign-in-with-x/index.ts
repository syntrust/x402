import { config } from "dotenv";
import { x402Client, x402HTTPClient, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { base58 } from "@scure/base";
import { createSIWxClientHook, type SolanaSigner } from "@x402/extensions/sign-in-with-x";
config();

function normalizeEvmPrivateKey(value: string | undefined): `0x${string}` | undefined {
  if (!value) return undefined;

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

const evmPrivateKey = normalizeEvmPrivateKey(process.env.EVM_PRIVATE_KEY);
const svmPrivateKey = process.env.SVM_PRIVATE_KEY as string | undefined;
const baseURL = process.env.RESOURCE_SERVER_URL || "http://localhost:4021";

// Require at least one key
if (!evmPrivateKey && !svmPrivateKey) {
  console.error("Error: At least one private key required (EVM_PRIVATE_KEY or SVM_PRIVATE_KEY)");
  process.exit(1);
}

const evmSigner = evmPrivateKey ? privateKeyToAccount(evmPrivateKey) : undefined;
let svmSigner: Awaited<ReturnType<typeof createKeyPairSignerFromBytes>> | undefined;
if (svmPrivateKey) {
  try {
    const bytes = base58.decode(svmPrivateKey.trim());
    if (bytes.byteLength !== 64) {
      throw new Error(`SVM_PRIVATE_KEY must decode to 64 bytes (got ${bytes.byteLength})`);
    }
    svmSigner = await createKeyPairSignerFromBytes(bytes);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Invalid SVM_PRIVATE_KEY (expected base58-encoded 64-byte keypair)";

    if (evmSigner) {
      // console.warn(`[warn] Ignoring invalid SVM_PRIVATE_KEY: ${message}`);
    } else {
      throw new Error(`[config] ${message}`);
    }
  }
}

// Configure client with available signers
const client = new x402Client();
if (evmSigner) {
  client.register("eip155:*", new ExactEvmScheme(evmSigner));
}
if (svmSigner) {
  client.register("solana:*", new ExactSvmScheme(svmSigner));
}

// Configure HTTP client with SIWX hooks for each signer
// Each hook auto-detects the chain type and fails gracefully if mismatched
const httpClient = new x402HTTPClient(client);
if (evmSigner) {
  httpClient.onPaymentRequired(createSIWxClientHook(evmSigner));
}
if (svmSigner) {
  // Cast needed until @x402/extensions is rebuilt
  httpClient.onPaymentRequired(createSIWxClientHook(svmSigner as SolanaSigner));
}

const rawFetch = fetch;
let tracedRequestCounter = 0;

function headersToRecord(headers?: HeadersInit): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return { ...headers };
}

function resolveRequestTraceInfo(
  input: RequestInfo | URL,
  init?: RequestInit,
): { method: string; url: string; headers: Record<string, string> } {
  const isRequest = typeof Request !== "undefined" && input instanceof Request;
  const url = typeof input === "string" ? input : isRequest ? input.url : input.toString();
  const method = init?.method ?? (isRequest ? input.method : "GET");

  const baseHeaders = isRequest ? headersToRecord(input.headers) : {};
  const overrideHeaders = headersToRecord(init?.headers);
  const headers = { ...baseHeaders, ...overrideHeaders };

  return { method, url, headers };
}

function maskHeaderValue(value: string | undefined, visible = 12): string | undefined {
  if (!value) return value;
  if (value.length <= visible * 2) return value;
  return `${value.slice(0, visible)}...${value.slice(-visible)}`;
}

function formatKeyHeaders(record: Record<string, string>, names: string[]): string {
  return names
    .map(name => {
      const value = maskHeaderValue(record[name]);
      return value ? `${name}=${value}` : undefined;
    })
    .filter((entry): entry is string => Boolean(entry))
    .join(" ");
}

const keyRequestHeaders = [
  "payment-required",
  "payment-signature",
  "sign-in-with-x",
];

const keyResponseHeaders = [
  "payment-required",
  "payment-response",
  "sign-in-with-x",
  "www-authenticate",
  "access-control-expose-headers",
];

const tracedFetch: typeof fetch = async (input, init) => {
  const requestId = ++tracedRequestCounter;
  const { method, url, headers: reqHeaders } = resolveRequestTraceInfo(input, init);
  const reqHeadersLowerCase = Object.fromEntries(
    Object.entries(reqHeaders).map(([k, v]) => [k.toLowerCase(), v]),
  );

  console.log(`[client:req:${requestId}] --> ${method} ${url}`);
  console.log(
    `[client:req:${requestId}] req headers ${formatKeyHeaders(reqHeadersLowerCase, keyRequestHeaders)}`,
  );

  const response = await rawFetch(input, init);
  const resHeaders = Object.fromEntries(
    Array.from(response.headers.entries()).map(([k, v]) => [k.toLowerCase(), v]),
  );
  console.log(`[client:req:${requestId}] <-- ${response.status} ${method} ${url}`);
  console.log(
    `[client:req:${requestId}] res headers ${formatKeyHeaders(resHeaders, keyResponseHeaders)}`,
  );

  return response;
};

const fetchWithPayment = wrapFetchWithPayment(tracedFetch, httpClient);

/**
 * Decodes and logs payment response from headers if present.
 *
 * @param response - The fetch response object
 * @returns true if payment response was found and logged
 */
function logPaymentResponse(response: Response): boolean {
  try {
    const paymentResponse = httpClient.getPaymentSettleResponse(name => response.headers.get(name));
    if (paymentResponse) {
      console.log("   ✓ Paid via payment settlement");
      console.log("   Payment details:", JSON.stringify(paymentResponse, null, 2));
      return true;
    }
  } catch {
    // No payment response header present (expected for SIWX auth)
  }
  return false;
}

/**
 * Demonstrates the SIWX flow for a given resource path.
 *
 * @param path - The resource path to request
 */
async function demonstrateResource(path: string): Promise<void> {
  const url = `${baseURL}${path}`;
  console.log(`\n--- ${path} ---`);

  // First request: pays for access
  // console.log("1. First request...");
  const response1 = await fetchWithPayment(url);
  const body1 = await response1.json();

  const hasPayment = logPaymentResponse(response1);
  if (response1.ok) {
    if (!hasPayment) {
      console.log("   ✓ Authenticated via SIWX (previously paid)");
    }
    console.log("   Response:", body1);
  } else if (body1.error) {
    console.log("   ✗ Payment failed:", body1.details || body1.error);
  }

  // // Second request: SIWX hook automatically proves we already paid
  // console.log("2. Second request...");
  // const response2 = await fetchWithPayment(url);
  // const body2 = await response2.json();

  // const hasPayment = logPaymentResponse(response2);
  // if (response2.ok) {
  //   if (!hasPayment) {
  //     console.log("   ✓ Authenticated via SIWX (previously paid)");
  //   }
  //   console.log("   Response:", body2);
  // } else if (body2.error) {
  //   console.log("   ✗ Payment failed:", body2.details || body2.error);
  // }
}

/**
 * Demonstrates auth-only SIWX flow (no payment required).
 * The client hook handles the 402 → sign → retry cycle automatically.
 */
async function demonstrateAuthOnly(): Promise<void> {
  const url = `${baseURL}/profile`;
  console.log("\n--- /profile (auth-only, no payment) ---");

  // fetchWithPayment handles auth-only routes the same way as paid routes:
  // 402 → SIWX client hook signs the challenge → retry with signature
  const response = await fetchWithPayment(url);
  const body = await response.json();

  if (response.ok) {
    console.log("   ✓ Authenticated via SIWX (no payment required)");
    console.log("   Response:", body);
  } else {
    console.log("   ✗ Auth failed:", body);
  }
}

/**
 * Main entry point - demonstrates SIWX authentication flow.
 */
async function main(): Promise<void> {
  if (evmSigner) {
    console.log(`Client EVM address: ${evmSigner.address}`);
  }
  if (svmSigner) {
    console.log(`Client SVM address: ${svmSigner.address}`);
  }
  console.log(`Server: ${baseURL}`);

  // Auth-only: SIWX signature without payment
  // await demonstrateAuthOnly();

  // await demonstrateResource("/weather");

  // Small delay to avoid facilitator race condition with rapid payments
  await new Promise(resolve => setTimeout(resolve, 300));

  await demonstrateResource("/joke");

  console.log("\nDone. /profile used auth-only SIWX. /weather and /joke used payment + SIWX.");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
