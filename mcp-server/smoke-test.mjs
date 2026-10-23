/** MCP Server 冒烟测试：初始化 → list tools → call tarot_search */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["mcp-server/index.mjs"],
});
const client = new Client({ name: "smoke-test", version: "1.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));

const search = await client.callTool({ name: "tarot_search", arguments: { query: "复合 感情", top_k: 3 } });
console.log("SEARCH RESULT:\n" + search.content[0].text);

const meaning = await client.callTool({ name: "tarot_card_meaning", arguments: { card_id: "愚人" } });
console.log("\nMEANING (first 200):\n" + meaning.content[0].text.slice(0, 200));

const draw = await client.callTool({ name: "tarot_draw_cards", arguments: { spread: "three" } });
console.log("\nDRAW (first 150):\n" + draw.content[0].text.slice(0, 150));

await client.close();
console.log("\nMCP SMOKE TEST PASSED");
