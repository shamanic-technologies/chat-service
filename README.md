# Chat Service

Backend chat service powering Foxy, the MCP Factory AI assistant. Streams Gemini AI responses via SSE with MCP tool calling support.

## SSE Protocol

`POST /chat` with headers `Content-Type: application/json` and `X-API-Key: <your-key>`.

Request body:
```json
{ "message": "Hello", "sessionId": "optional-uuid" }
```

The response is a stream of SSE events in this order:

### 1. Session ID
```
data: {"sessionId":"uuid"}
```

### 2. Streaming tokens
Streamed incrementally as the AI generates its response:
```
data: {"type":"token","content":"Here's"}
data: {"type":"token","content":" what I"}
data: {"type":"token","content":" suggest..."}
```

### 3. Tool calls (optional)
If the AI invokes an MCP tool:
```
data: {"type":"tool_call","name":"search_leads","args":{"query":"..."}}
data: {"type":"tool_result","name":"search_leads","result":{...}}
```
After a tool result, more `token` events follow with the AI's continuation.

### 4. Buttons (optional)
AI-generated quick-reply buttons, sent after all tokens are done:
```
data: {"type":"buttons","buttons":[{"label":"Send Cold Emails","value":"Send Cold Emails"},{"label":"Create API Key","value":"Create API Key"}]}
```
Buttons are extracted from the AI response when it ends with lines formatted as `- [Button Text]`. The button `label` and `value` are both set to the text inside the brackets.

### 5. Done
```
data: "[DONE]"
```

## Rendering buttons on the frontend

Listen for the `{"type":"buttons"}` SSE event. It arrives **after** all token streaming is complete and **before** `[DONE]`. Each button has a `label` (display text) and `value` (text to send back as the next user message). Only render buttons when `buttons.length > 0`.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `GEMINI_API_KEY` | Yes | Google Gemini API key |
| `CHAT_SERVICE_DATABASE_URL` | Yes | PostgreSQL connection string |
| `PORT` | No | Server port (default: 3002) |
