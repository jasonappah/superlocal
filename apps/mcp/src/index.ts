#!/usr/bin/env bun
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { createInboxClient, type InboxClient } from 'inbox-sdk/client'
import { TOOL_CATALOG, callSuperlocalTool } from './tools'

const SERVER_NAME = 'superlocal-mail'
const SERVER_VERSION = '0.1.0'

function report(code: string): void {
  // stdout carries the MCP protocol only; every diagnostic goes to stderr.
  console.error(`[${code}]`)
}

function loadConnection(): { client: InboxClient } | undefined {
  const rawUrl = process.env.SUPERLOCAL_URL ?? process.env.SUPERLOCAL_HOST
  if (!rawUrl) { report('SUPERLOCAL_URL_REQUIRED'); return undefined }
  const url = (() => { try { return new URL(rawUrl) } catch { report('SUPERLOCAL_URL_INVALID'); return undefined } })()
  if (!url || !['http:', 'https:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)) {
    report('SUPERLOCAL_URL_NOT_LOOPBACK')
    return undefined
  }
  const token = process.env.SUPERLOCAL_MCP_TOKEN
  if (!token || !/^superlocal_mcp_[A-Za-z0-9_-]{32}$/.test(token)) {
    report('SUPERLOCAL_MCP_TOKEN_INVALID')
    return undefined
  }
  // Credentials stay in this process: they are sent only to the configured loopback host.
  const client = createInboxClient({ baseUrl: url.origin === rawUrl.replace(/\/+$/, '') ? url.origin : rawUrl.replace(/\/+$/, ''), headers: { Authorization: `Bearer ${token}` } })
  return { client }
}

function start(): void {
  const loaded = loadConnection()
  if (!loaded) { process.exitCode = 1; return }
  const server = new Server({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_CATALOG }))
  server.setRequestHandler(CallToolRequestSchema, async request =>
    await callSuperlocalTool(loaded, request.params.name, request.params.arguments))
  void server.connect(new StdioServerTransport()).then(() => {
    report(`${SERVER_NAME} ready; connecting to the configured Superlocal host.`)
  }, () => {
    report('MCP_START_FAILED')
    process.exitCode = 1
  })
}

start()
