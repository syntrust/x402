import { config } from "dotenv";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
config();

const evmAddress = process.env.EVM_ADDRESS as `0x${string}`;
const svmAddress = process.env.SVM_ADDRESS;
if (!evmAddress || !svmAddress) {
  console.error("Missing required environment variables");
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

app.use((req, res, next) => {
  const requestId = ++requestCounter;
  const startedAt = Date.now();
  const paymentRequired = getHeaderValue(req.headers["payment-required"]);
  const paymentSignature = getHeaderValue(req.headers["payment-signature"]);
  const signInWithX = getHeaderValue(req.headers["sign-in-with-x"]);

  console.log(
    `[req:${requestId}] --> ${req.method} ${req.originalUrl} ip=${req.ip} ua="${req.headers["user-agent"] ?? "unknown"}"`,
  );
  console.log(
    `[req:${requestId}] headers payment-required=${maskHeaderValue(paymentRequired)} payment-signature=${maskHeaderValue(paymentSignature)} sign-in-with-x=${maskHeaderValue(signInWithX)}`,
  );

  res.on("finish", () => {
    const durationMs = Date.now() - startedAt;
    const paymentResponse = res.getHeader("PAYMENT-RESPONSE");
    const paymentRequiredResponse = res.getHeader("PAYMENT-REQUIRED");

    console.log(
      `[req:${requestId}] <-- ${res.statusCode} ${req.method} ${req.originalUrl} ${durationMs}ms`,
    );
    console.log(
      `[req:${requestId}] response payment-required=${maskHeaderValue(normalizeHeaderForLog(paymentRequiredResponse as string | number | string[] | undefined))} payment-response=${maskHeaderValue(normalizeHeaderForLog(paymentResponse as string | number | string[] | undefined))}`,
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
          {
            scheme: "exact",
            price: "$0.001",
            network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
            payTo: svmAddress,
          },
        ],
        description: "Weather data",
        mimeType: "application/json",
      },
    },
    resourceServer,
  ),
);

app.get("/weather", (req, res) => {
  console.log(
    `[app] weather handler city=${getHeaderValue(req.headers["x-city"]) ?? "unknown"} path=${req.path}`,
  );
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
