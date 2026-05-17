# SQL Server MCP Server

A simple, secure MCP (Model Context Protocol) server that gives Claude Desktop (or any MCP client) read-only access to SQL Server metadata. Lets you ask your AI tool questions about your database schema, stored procedures, triggers, indexes, SQL Agent jobs, linked servers, and more — without exposing any user table data.

## What it can read

| Object | Accessible |
|---|---|
| Table and column names | ✅ |
| Stored procedure code | ✅ |
| Function code | ✅ |
| Trigger code | ✅ |
| View definitions | ✅ |
| Indexes and constraints | ✅ |
| Linked servers | ✅ |
| SQL Agent jobs and schedules | ✅ |
| Server configuration | ✅ |
| User table data (rows) | ❌ Blocked |

## How it works

Claude can query SQL Server system metadata views through a single `query` tool. Access to user table data is blocked at two independent layers:

1. **SQL Server login** — `claude_readonly` is granted `VIEW DEFINITION` only, with no `SELECT` on user tables
2. **MCP server** — every query is checked against an allowlist of permitted metadata sources before execution

## Prerequisites

- Node.js 18+
- SQL Server (any version, local or remote)
- Claude Desktop

## Setup

### 1. Create the read-only SQL Server login

Replace the password in the following script and run it in SSMS as `sa` or a sysadmin account:

```sql
-- Create the login
CREATE LOGIN claude_readonly WITH PASSWORD = 'StrongPassword123!';

-- Server-level grants
GRANT VIEW ANY DATABASE TO claude_readonly;
GRANT VIEW ANY DEFINITION TO claude_readonly;
GRANT VIEW SERVER STATE TO claude_readonly;

-- All user databases
DECLARE @dbname NVARCHAR(128);
DECLARE @sql NVARCHAR(500);

DECLARE db_cursor CURSOR FOR
    SELECT name
    FROM sys.databases
    WHERE database_id > 4
    AND state_desc = 'ONLINE'
    AND is_read_only = 0;

OPEN db_cursor;
FETCH NEXT FROM db_cursor INTO @dbname;

WHILE @@FETCH_STATUS = 0
BEGIN
    SET @sql = N'
        USE [' + @dbname + N'];
        IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = ''claude_readonly'')
        BEGIN
            CREATE USER claude_readonly FOR LOGIN claude_readonly;
        END
        GRANT VIEW DEFINITION TO claude_readonly;
    ';
    EXEC sp_executesql @sql;
    FETCH NEXT FROM db_cursor INTO @dbname;
END

CLOSE db_cursor;
DEALLOCATE db_cursor;

-- msdb (SQL Agent jobs)
USE msdb;
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = 'claude_readonly')
BEGIN
    CREATE USER claude_readonly FOR LOGIN claude_readonly;
    EXEC sp_addrolemember 'SQLAgentReaderRole', 'claude_readonly';
    GRANT VIEW DEFINITION TO claude_readonly;
END

-- master (linked servers, server config)
USE master;
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = 'claude_readonly')
BEGIN
    CREATE USER claude_readonly FOR LOGIN claude_readonly;
    GRANT VIEW DEFINITION TO claude_readonly;
END
```

### 2. Install dependencies and build

```bash
npm install
npm run build
```

### 3. Configure Claude Desktop

Open `%APPDATA%\Claude\claude_desktop_config.json` and add:

```json
{
  "mcpServers": {
    "sqlserver": {
      "command": "node",
      "args": ["C:\\sqlserver-mcp\\dist\\index.js"],
      "env": {
        "MSSQL_SERVER": "localhost",
        "MSSQL_USER": "claude_readonly",
        "MSSQL_PASSWORD": "StrongPassword123!"
      }
    }
  }
}
```

Adjust the path and credentials to match your environment. Optional env vars (defaults shown):

| Variable | Default | Notes |
|---|---|---|
| `MSSQL_DATABASE` | `master` | Starting database |
| `MSSQL_ENCRYPT` | `true` | Set `false` for local dev if needed |
| `MSSQL_TRUST_SERVER_CERTIFICATE` | `true` | Set `false` for Azure/production |

### 4. Restart Claude Desktop

Fully quit Claude Desktop (check the system tray) and relaunch. You should see a tools icon in the chat input confirming the MCP server is connected.

## Example questions to ask

- *"What tables are in MyDatabase and how are they related?"*
- *"Show me all stored procedures that reference the Orders table"*
- *"What does the usp_ProcessOrder stored procedure do?"*
- *"List all triggers on the Customers table"*
- *"What SQL Agent jobs are configured and when do they run?"*
- *"Are there any linked servers set up on this instance?"*
- *"Show me all indexes on the Orders table"*
- *"What foreign key relationships exist in MyDatabase?"*

## Security

Three independent layers prevent access to user data:

**Layer 1 — SQL Server login permissions**
`claude_readonly` has `VIEW DEFINITION` only. No `SELECT` is ever granted on user tables, so any attempt to query row data fails at the database level.

**Layer 2 — Metadata allowlist**
Every `FROM` and `JOIN` source in a query is checked before execution. Only the following are permitted:
- `sys.*` — system catalog views
- `INFORMATION_SCHEMA.*` — standard schema views
- `msdb.dbo.sysjobs`, `sysjobsteps`, `sysjobhistory`, `sysschedules`, etc.

**Layer 3 — Write keyword blocklist**
Queries containing `INSERT`, `UPDATE`, `DELETE`, `DROP`, `CREATE`, `ALTER`, `TRUNCATE`, `MERGE`, `EXEC`, `EXECUTE`, `BULK`, or `XP_*` are rejected before reaching the database.

### A note on secrets

`claude_desktop_config.json` is a plain text file. Treat it like any other file containing credentials — do not check it into source control, and restrict access to it as you would any sensitive config file.

## Removing access

To fully remove the `claude_readonly` login:

```sql
DECLARE @dbname NVARCHAR(128);
DECLARE @sql NVARCHAR(500);

DECLARE db_cursor CURSOR FOR
    SELECT name FROM sys.databases
    WHERE database_id > 4
    AND state_desc = 'ONLINE'
    AND is_read_only = 0;

OPEN db_cursor;
FETCH NEXT FROM db_cursor INTO @dbname;

WHILE @@FETCH_STATUS = 0
BEGIN
    SET @sql = N'
        USE [' + @dbname + N'];
        IF EXISTS (SELECT 1 FROM sys.database_principals WHERE name = ''claude_readonly'')
            DROP USER claude_readonly;
    ';
    EXEC sp_executesql @sql;
    FETCH NEXT FROM db_cursor INTO @dbname;
END

CLOSE db_cursor;
DEALLOCATE db_cursor;

USE msdb;
IF EXISTS (SELECT 1 FROM sys.database_principals WHERE name = 'claude_readonly')
    DROP USER claude_readonly;

USE master;
IF EXISTS (SELECT 1 FROM sys.database_principals WHERE name = 'claude_readonly')
    DROP USER claude_readonly;

IF EXISTS (SELECT 1 FROM sys.server_principals WHERE name = 'claude_readonly')
    DROP LOGIN claude_readonly;
```