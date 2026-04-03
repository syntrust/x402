/**
 * OpenAI Chatbot with MCP Tools + x402 Payments
 *
 * A complete chatbot implementation showing how to integrate:
 * - OpenAI GPT (the LLM)
 * - MCP Client (tool discovery and execution)
 * - x402 Payment Protocol (automatic payment for paid tools)
 *
 * This demonstrates the ACTUAL MCP client methods used in production chatbots.
 */

import { config } from "dotenv";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { createx402MCPClient } from "@x402/mcp";
import { privateKeyToAccount } from "viem/accounts";
import OpenAI from "openai";
import * as readline from "readline";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

config();

// ============================================================================
// Configuration
// ============================================================================

type ChatMode = "openai" | "local";

const openaiKey = process.env.OPENAI_API_KEY?.trim();
const requestedMode = (process.env.CHAT_MODE || "auto").trim().toLowerCase();

const effectiveMode: ChatMode =
  requestedMode === "local" ? "local" : openaiKey ? "openai" : "local";

if (requestedMode === "openai" && !openaiKey) {
  console.error("❌ CHAT_MODE=openai but OPENAI_API_KEY is missing");
  console.error("   Set OPENAI_API_KEY or use CHAT_MODE=local");
  process.exit(1);
}

function normalizeEvmPrivateKey(rawValue: string): `0x${string}` {
  // Accept both quoted/unquoted .env values with or without 0x prefix.
  const normalized = rawValue.trim().replace(/^['"]|['"]$/g, "");
  const hex = normalized.startsWith("0x") ? normalized.slice(2) : normalized;

  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      "EVM_PRIVATE_KEY must be a 32-byte hex string (64 hex chars), with optional 0x prefix",
    );
  }

  return `0x${hex}` as `0x${string}`;
}

const evmPrivateKeyRaw = process.env.EVM_PRIVATE_KEY;
if (!evmPrivateKeyRaw) {
  console.error("❌ EVM_PRIVATE_KEY environment variable is required");
  console.error("   Generate one with: cast wallet new");
  process.exit(1);
}
const evmPrivateKey = normalizeEvmPrivateKey(evmPrivateKeyRaw);

const serverUrl = process.env.MCP_SERVER_URL || "http://localhost:4022";

function parseCityFromWeatherPrompt(input: string): string | undefined {
  const inOrForMatch = input.match(/weather\s+(?:in|for)\s+([a-zA-Z][a-zA-Z\s.'-]{1,60})/i);
  if (inOrForMatch?.[1]) return inOrForMatch[1].trim();

  const trailingMatch = input.match(/\bin\s+([a-zA-Z][a-zA-Z\s.'-]{1,60})[?.!]?$/i);
  if (trailingMatch?.[1]) return trailingMatch[1].trim();

  return undefined;
}

// ============================================================================
// Chatbot Implementation
// ============================================================================

/**
 * Main chatbot loop - demonstrates real MCP client usage patterns
 */
export async function main(): Promise<void> {
  console.log("\n🤖 MCP Chatbot with x402 Payments");
  console.log("━".repeat(70));

  // ========================================================================
  // SETUP 1: Initialize MCP client (connects to tool servers)
  // ========================================================================
  const evmSigner = privateKeyToAccount(evmPrivateKey);
  console.log(`💳 Wallet address: ${evmSigner.address}`);
  console.log(`🧠 Chat mode: ${effectiveMode === "openai" ? "OpenAI + tools" : "Local rules + tools"}`);

  const mcpClient = createx402MCPClient({
    name: "openai-mcp-chatbot",
    version: "1.0.0",
    schemes: [{ network: "eip155:84532", client: new ExactEvmScheme(evmSigner) }],
    autoPayment: true,
    onPaymentRequested: async context => {
      const price = context.paymentRequired.accepts[0];
      console.log(`\n💰 Payment requested for tool: ${context.toolName}`);
      console.log(`   Amount: ${price.amount} (${price.asset})`);
      console.log(`   Network: ${price.network}`);
      console.log(`   ✅ Approving payment...\n`);
      return true; // Auto-approve
    },
  });

  // ========================================================================
  // MCP TOUCHPOINT #1: connect()
  // Establish connection to MCP server
  // ========================================================================
  console.log(`🔌 Connecting to MCP server: ${serverUrl}`);
  const transport = new SSEClientTransport(new URL(`${serverUrl}/sse`));
  await mcpClient.connect(transport);
  console.log("✅ Connected to MCP server");

  // ========================================================================
  // MCP TOUCHPOINT #2: listTools()
  // Discover available tools from MCP server
  // ========================================================================
  console.log("\n📋 Discovering tools from MCP server...");
  const { tools: mcpTools } = await mcpClient.listTools();
  console.log(`Found ${mcpTools.length} tools:`);
  for (const tool of mcpTools) {
    const isPaid =
      tool.description?.toLowerCase().includes("payment") ||
      tool.description?.toLowerCase().includes("$");
    console.log(`   ${isPaid ? "💰" : "🆓"} ${tool.name}: ${tool.description}`);
  }

  const callToolAndFormatResult = async (
    toolName: string,
    toolArgs: Record<string, unknown>,
  ): Promise<string> => {
    console.log(`\n   📞 Calling: ${toolName}`);
    console.log(`   📝 Args: ${JSON.stringify(toolArgs)}`);

    const mcpResult = await mcpClient.callTool(toolName, toolArgs);

    if (mcpResult.paymentMade && mcpResult.paymentResponse) {
      console.log(`   💳 Payment settled!`);
      console.log(`      Transaction: ${mcpResult.paymentResponse.transaction}`);
      console.log(`      Network: ${mcpResult.paymentResponse.network}`);
    }

    const firstContent = mcpResult.content[0];
    const resultText =
      typeof firstContent?.text === "string"
        ? firstContent.text
        : firstContent
          ? JSON.stringify(firstContent)
          : "No content returned";

    console.log(
      `   ✅ Result: ${resultText.substring(0, 200)}${resultText.length > 200 ? "..." : ""}`,
    );
    return resultText;
  };

  let openai: OpenAI | undefined;
  let openaiTools: ChatCompletionTool[] = [];
  const conversationHistory: ChatCompletionMessageParam[] = [];

  if (effectiveMode === "openai") {
    // ======================================================================
    // SETUP 2: Initialize OpenAI (the LLM)
    // ======================================================================
    openai = new OpenAI({ apiKey: openaiKey });
    console.log("✅ OpenAI client initialized");

    // ======================================================================
    // HOST LOGIC: Convert MCP tools to OpenAI format
    // ======================================================================
    openaiTools = mcpTools.map(tool => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description || "",
        parameters: tool.inputSchema as Record<string, unknown>,
      },
    }));

    conversationHistory.push({
      role: "system",
      content:
        "You are a helpful assistant with access to MCP tools. When users ask about weather, use the get_weather tool. Be concise and friendly.",
    });
    console.log("✅ Converted to OpenAI tool format");
  } else {
    console.log("✅ Local mode ready (no OpenAI API calls)");
    console.log("   Tips: ask weather/ping, or use: /tool <name> <json-args>");
  }
  console.log("━".repeat(70));

  // ========================================================================
  // Interactive Chat Loop
  // ========================================================================
  console.log("\n💬 Chat started! Try asking:");
  console.log("   - 'What's the weather in Tokyo?'");
  console.log("   - 'Can you ping the server?'");
  console.log("   - 'quit' to exit\n");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  /**
   * Process one chat turn
   *
   * @param userInput - The user's message to process
   */
  const processTurn = async (userInput: string): Promise<void> => {
    if (effectiveMode === "local") {
      const normalizedInput = userInput.trim();

      if (normalizedInput.toLowerCase() === "help") {
        console.log("\n🤖 Bot: I can handle weather and ping with local rules.");
        console.log("   Examples:");
        console.log("   - What's the weather in Tokyo?");
        console.log("   - ping");
        console.log("   - /tool get_weather {\"city\":\"Shanghai\"}\n");
        return;
      }

      if (normalizedInput.toLowerCase().startsWith("/tool ")) {
        const parts = normalizedInput.split(/\s+/, 3);
        const toolName = parts[1];
        const rawArgs = parts[2];

        if (!toolName) {
          console.log("\n❌ Error: Usage: /tool <toolName> <json-args>\n");
          return;
        }

        let args: Record<string, unknown> = {};
        if (rawArgs) {
          try {
            const parsed = JSON.parse(rawArgs);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              args = parsed as Record<string, unknown>;
            } else {
              console.log("\n❌ Error: tool args must be a JSON object\n");
              return;
            }
          } catch {
            console.log("\n❌ Error: invalid JSON args for /tool command\n");
            return;
          }
        }

        try {
          const resultText = await callToolAndFormatResult(toolName, args);
          console.log(`\n🤖 Bot: ${resultText}\n`);
        } catch (error) {
          console.log(`\n❌ Error: ${error instanceof Error ? error.message : error}\n`);
        }
        return;
      }

      const lower = normalizedInput.toLowerCase();
      const hasWeatherIntent = lower.includes("weather");
      const hasPingIntent = lower === "ping" || lower.includes(" ping") || lower.includes("server");

      if (hasWeatherIntent) {
        const weatherTool = mcpTools.find(tool => tool.name === "get_weather");
        if (!weatherTool) {
          console.log("\n🤖 Bot: MCP server doesn't expose get_weather.\n");
          return;
        }

        const city = parseCityFromWeatherPrompt(normalizedInput);
        if (!city) {
          console.log("\n🤖 Bot: Please include a city, for example: What's the weather in Tokyo?\n");
          return;
        }

        try {
          const resultText = await callToolAndFormatResult("get_weather", { city });
          console.log(`\n🤖 Bot: ${resultText}\n`);
        } catch (error) {
          console.log(`\n❌ Error: ${error instanceof Error ? error.message : error}\n`);
        }
        return;
      }

      if (hasPingIntent) {
        const pingTool = mcpTools.find(tool => tool.name === "ping");
        if (!pingTool) {
          console.log("\n🤖 Bot: MCP server doesn't expose ping.\n");
          return;
        }

        try {
          const resultText = await callToolAndFormatResult("ping", {});
          console.log(`\n🤖 Bot: ${resultText}\n`);
        } catch (error) {
          console.log(`\n❌ Error: ${error instanceof Error ? error.message : error}\n`);
        }
        return;
      }

      console.log("\n🤖 Bot: In local mode I route by rules. Type `help` to see supported commands.\n");
      return;
    }

    if (!openai) {
      throw new Error("OpenAI client not initialized");
    }

    // Add user message to history
    conversationHistory.push({
      role: "user",
      content: userInput,
    });

    // ========================================================================
    // OPENAI CALL: Send conversation + tools to LLM
    // ========================================================================
    let response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: conversationHistory,
      tools: openaiTools,
      tool_choice: "auto", // Let LLM decide when to use tools
    });

    let assistantMessage = response.choices[0].message;

    // ========================================================================
    // TOOL EXECUTION LOOP
    // This is where MCP client is actually used!
    // ========================================================================
    let toolCallCount = 0;
    while (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
      toolCallCount++;
      console.log(
        `\n🔧 [Turn ${toolCallCount}] LLM is calling ${assistantMessage.tool_calls.length} tool(s)...`,
      );

      // Add assistant message with tool calls to history
      conversationHistory.push(assistantMessage);

      // Execute each tool call
      const toolResults: ChatCompletionMessageParam[] = [];

      for (const toolCall of assistantMessage.tool_calls) {
        const toolName = toolCall.function.name;
        const toolArgs = JSON.parse(toolCall.function.arguments);

        try {
          // ====================================================================
          // MCP TOUCHPOINT #3: callTool()
          // THIS IS THE MAIN TOUCHPOINT - Execute tool via MCP
          // Payment is handled automatically by x402MCPClient
          // ====================================================================
          const resultText = await callToolAndFormatResult(
            toolName,
            toolArgs as Record<string, unknown>,
          );

          // Format for OpenAI
          toolResults.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: resultText,
          });
        } catch (error) {
          console.log(`   ❌ Error: ${error instanceof Error ? error.message : error}`);

          // Send error to OpenAI so it can handle it
          toolResults.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: `Error executing tool: ${error instanceof Error ? error.message : error}`,
          });
        }
      }

      // Add tool results to conversation
      conversationHistory.push(...toolResults);

      // ========================================================================
      // Get LLM's response after seeing tool results
      // ========================================================================
      response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: conversationHistory,
        tools: openaiTools,
        tool_choice: "auto",
      });

      assistantMessage = response.choices[0].message;
    }

    // ========================================================================
    // Display final assistant response
    // ========================================================================
    if (assistantMessage.content) {
      conversationHistory.push(assistantMessage);
      console.log(`\n🤖 Bot: ${assistantMessage.content}\n`);
    }
  };

  /**
   * Main chat loop
   */
  const chatLoop = async (): Promise<void> => {
    return new Promise(resolve => {
      rl.question("You: ", async input => {
        const userInput = input.trim();

        if (userInput.toLowerCase() === "quit" || userInput.toLowerCase() === "exit") {
          console.log("\n👋 Closing connections...");

          // ====================================================================
          // MCP TOUCHPOINT #4: close()
          // Clean shutdown of MCP connection
          // ====================================================================
          await mcpClient.close();
          rl.close();
          console.log("✅ Goodbye!\n");
          process.exit(0);
          return;
        }

        if (!userInput) {
          resolve();
          return;
        }

        try {
          await processTurn(userInput);
        } catch (error) {
          console.log(`\n❌ Error: ${error instanceof Error ? error.message : error}\n`);
        }

        resolve();
      });
    });
  };

  // Start chat loop
  while (true) {
    await chatLoop();
  }
}

// ============================================================================
// Entry Point
// ============================================================================

main().catch(error => {
  console.error("\n💥 Fatal error:", error);
  process.exit(1);
});
