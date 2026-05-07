import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import sql from "mssql";

// =============================================
// Connection config from environment variables
// Set these in claude_desktop_config.json
// =============================================
const server     = process.env.MSSQL_SERVER;
const user       = process.env.MSSQL_USER;
const password   = process.env.MSSQL_PASSWORD;
const database   = process.env.MSSQL_DATABASE ?? "master";
const encrypt    = process.env.MSSQL_ENCRYPT ?? "true";
const trustServerCertificate = process.env.MSSQL_TRUST_SERVER_CERTIFICATE ?? "true";

if (!server || !user || !password) {
  console.error("Error: MSSQL_SERVER, MSSQL_USER and MSSQL_PASSWORD are required");
  process.exit(1);
}

const CONNECTION_STRING =
  `Server=${server};Database=${database};User Id=${user};Password=${password};Encrypt=${encrypt};TrustServerCertificate=${trustServerCertificate}`;

// =============================================
// Blocked keywords - no writes, no exec
// =============================================
const BLOCKED_PATTERNS: RegExp[] = [
  /\bINSERT\b/i,
  /\bUPDATE\b/i,
  /\bDELETE\b/i,
  /\bDROP\b/i,
  /\bCREATE\b/i,
  /\bALTER\b/i,
  /\bTRUNCATE\b/i,
  /\bMERGE\b/i,
  /\bEXEC\b/i,
  /\bEXECUTE\b/i,
  /\bBULK\b/i,
  /\bXP_\w+/i,
];

// =============================================
// Allowed sources - ONLY system metadata views.
// Queries touching anything outside this list
// are blocked, preventing access to user data.
// =============================================
const ALLOWED_SOURCES: RegExp[] = [
  // System catalog views (sys.*)
  /\bSYS\.\w+/i,
  // INFORMATION_SCHEMA views
  /\bINFORMATION_SCHEMA\.\w+/i,
  // msdb metadata tables for SQL Agent jobs, backup history etc.
  /\bMSDB\.DBO\.SYS\w+/i,
  /\bMSDB\.DBO\.(SYSJOBS|SYSJOBSTEPS|SYSJOBHISTORY|SYSOPERATORS|SYSCATEGORIES|SYSALERTS|SYSSCHEDULES|SYSJOBSCHEDULES)\b/i,
];

function stripComments(query: string): string {
  return query
    .replace(/--.*$/gm, "")           // strip single-line comments
    .replace(/\/\*[\s\S]*?\*\//g, "") // strip block comments
    .trim();
}

function isSafe(query: string): boolean {
  const stripped = stripComments(query);
  return !BLOCKED_PATTERNS.some((pattern) => pattern.test(stripped));
}

// Extract all FROM/JOIN sources and verify every one is a permitted metadata view.
function isMetadataOnly(query: string): { allowed: boolean; offender?: string } {
  const stripped = stripComments(query);
  const sourcePattern = /(?:FROM|JOIN)\s+([\w.\[\]]+)/gi;
  let match: RegExpExecArray | null;

  while ((match = sourcePattern.exec(stripped)) !== null) {
    const source = match[1];
    const allowed = ALLOWED_SOURCES.some((pattern) => pattern.test(source));
    if (!allowed) {
      return { allowed: false, offender: source };
    }
  }

  return { allowed: true };
}

// =============================================
// Connect to SQL Server
// =============================================
let pool: sql.ConnectionPool;

try {
  pool = await sql.connect(CONNECTION_STRING);
  console.error("Connected to SQL Server");
} catch (err) {
  console.error("Failed to connect to SQL Server:", (err as Error).message);
  process.exit(1);
}

// =============================================
// MCP Server
// =============================================
const mcpServer = new McpServer({
  name: "sqlserver",
  version: "1.0.0",
});

mcpServer.registerTool(
  "query",
  {
    title: "SQL Query",
    description:
      "Run a read-only SQL query against SQL Server system metadata views ONLY. " +
      "User table data is not accessible. Permitted sources: " +
      "sys.* (sys.tables, sys.columns, sys.procedures, sys.sql_modules, sys.triggers, sys.servers, sys.indexes, etc.), " +
      "INFORMATION_SCHEMA.* (INFORMATION_SCHEMA.TABLES, INFORMATION_SCHEMA.COLUMNS, etc.), " +
      "msdb.dbo.sysjobs, msdb.dbo.sysjobsteps, msdb.dbo.sysjobhistory, msdb.dbo.sysschedules. " +
      "Always use fully qualified names e.g. [dbo].[TableName].",
    inputSchema: {
      sql: z.string().describe("The SQL SELECT query to execute against system metadata views"),
    },
  },
  async ({ sql: query }): Promise<{ content: { type: "text"; text: string }[] }> => {
    if (!query?.trim()) {
      return { content: [{ type: "text", text: "Error: No SQL query provided" }] };
    }

    if (!isSafe(query)) {
      return {
        content: [{
          type: "text",
          text: "Error: Query blocked — modification keywords (INSERT, UPDATE, DELETE, DROP, etc.) are not allowed.",
        }],
      };
    }

    const metadataCheck = isMetadataOnly(query);
    if (!metadataCheck.allowed) {
      return {
        content: [{
          type: "text",
          text: `Error: Query blocked — access to '${metadataCheck.offender}' is not permitted. ` +
                "Only system metadata views (sys.*, INFORMATION_SCHEMA.*, msdb system tables) are allowed. " +
                "User table data is not accessible through this tool.",
        }],
      };
    }

    try {
      const result = await pool.request().query(query);
      const rows = result.recordset ?? [];
      return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `SQL error: ${(err as Error).message}` }] };
    }
  }
);

// =============================================
// Start
// =============================================
const transport = new StdioServerTransport();
await mcpServer.connect(transport);
console.error("SQL Server MCP server running");