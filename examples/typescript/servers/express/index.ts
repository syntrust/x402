import { config } from "dotenv";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { PaywallConfig } from "@x402/express";
import { createPaywall } from "@x402/paywall";
import { evmPaywall } from "@x402/paywall/evm";
config();

const evmAddress = process.env.EVM_ADDRESS as `0x${string}`;
if (!evmAddress) {
  console.error("Missing required environment variable: EVM_ADDRESS");
  process.exit(1);
}

const facilitatorUrl = process.env.FACILITATOR_URL;
if (!facilitatorUrl) {
  console.error("❌ FACILITATOR_URL environment variable is required");
  process.exit(1);
}
const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });

const app = express();
let requestCounter = 0;
const paywallConfig: PaywallConfig = {
  appName: "x402 Express Demo",
  testnet: true,
};
const paywallProvider = createPaywall().withNetwork(evmPaywall).build();

function getHeaderValue(value: string | string[] | undefined): string | undefined {
  if (!value) return undefined;
  return Array.isArray(value) ? value.join(",") : value;
}

function normalizeHeaderForLog(
  value: string | number | string[] | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") return String(value);
  return getHeaderValue(value);
}

function maskHeaderValue(value: string | undefined, visible = 12): string | undefined {
  if (!value) return value;
  if (value.length <= visible * 2) return value;
  return `${value.slice(0, visible)}...${value.slice(-visible)}`;
}

function isX402HeaderName(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    normalized.startsWith("payment-") ||
    normalized.startsWith("x402-") ||
    normalized === "x402" ||
    normalized === "x-payment" ||
    normalized === "sign-in-with-x"
  );
}

function formatX402HeadersForLog(
  headers: Record<string, string | number | string[] | undefined>,
): string {
  const serialized = Object.entries(headers)
    .filter(([name]) => isX402HeaderName(name))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${name}=${maskHeaderValue(normalizeHeaderForLog(value))}`);

  return serialized.length > 0 ? serialized.join(" ") : "none";
}

app.use((req, res, next) => {
  const requestId = ++requestCounter;
  const startedAt = Date.now();

  console.log(`[req:${requestId}] --> ${req.method} ${req.originalUrl}`);
  console.log(
    `[req:${requestId}] x402 request headers ${formatX402HeadersForLog(req.headers as Record<string, string | number | string[] | undefined>)}`,
  );

  res.on("finish", () => {
    const durationMs = Date.now() - startedAt;
    const responseHeaders = res.getHeaders();

    console.log(
      `[req:${requestId}] <-- ${res.statusCode} ${req.method} ${req.originalUrl} ${durationMs}ms`,
    );
    console.log(
      `[req:${requestId}] x402 response headers ${formatX402HeadersForLog(responseHeaders as Record<string, string | number | string[] | undefined>)}`,
    );
  });

  next();
});

const resourceServer = new x402ResourceServer(facilitatorClient)
  .register("eip155:84532", new ExactEvmScheme())
  .register("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", new ExactSvmScheme())
  .onBeforeVerify(async context => {
    console.log(
      `[x402] beforeVerify network=${context.requirements.network} amount=${context.requirements.amount} scheme=${context.requirements.scheme}`,
    );
  })
  .onAfterVerify(async context => {
    console.log(
      `[x402] afterVerify isValid=${context.result.isValid} payer=${context.result.payer ?? "unknown"}`,
    );
  })
  .onVerifyFailure(async context => {
    console.error("[x402] verifyFailure", context.error);
  })
  .onBeforeSettle(async context => {
    console.log(
      `[x402] beforeSettle network=${context.requirements.network} amount=${context.requirements.amount} scheme=${context.requirements.scheme}`,
    );
  })
  .onAfterSettle(async context => {
    console.log(
      `[x402] afterSettle success=${context.result.success} tx=${context.result.transaction}`,
    );
  })
  .onSettleFailure(async context => {
    console.error("[x402] settleFailure", context.error);
  });

app.use(
  paymentMiddleware(
    {
      "GET /weather": {
        accepts: [
          {
            scheme: "exact",
            price: "$0.001",
            network: "eip155:84532",
            payTo: evmAddress,
          },
        ],
        description: "Weather data",
        mimeType: "application/json",
      },
    },
    resourceServer,
    paywallConfig,
    paywallProvider,
  ),
);

app.get("/weather", (req, res) => {
  console.log(`[app] weather handler path=${req.path}`);
  res.send({
    report: {
      weather: "sunny",
      temperature: 70,
    },
  });
});

app.listen(4021, () => {
  console.log(`Server listening at http://localhost:${4021}`);
});
