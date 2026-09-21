# Discord bot — AGENTO V2

The bot uses `AgentRuntime` against your running salon API. All eleven endpoints from the previous salon example are retained: catalog search, categories, groups, services, service details, employees, variants, availability, booking, my appointments and featured services.

## Run on Windows (PowerShell)

From the repository root:

```powershell
npm ci
npm run build
cd examples/discord-bot
npm ci
Copy-Item .env.example .env
```

Edit `.env`:

```dotenv
DISCORD_BOT_TOKEN=your-discord-bot-token
OPENAI_API_KEY=your-openai-api-key
AGENTO_API_BASE_URL=http://localhost:3000
AGENTO_ALLOW_INSECURE_HTTP=true
AGENTO_USER_ACCESS_TOKEN=your-api-user-access-token
DISCORD_TEST_USER_ID=your-discord-user-id
AGENTO_DEBUG=true
```

Start your API, then:

```powershell
npm run dev
```

Enable **Message Content Intent** in your Discord application's Bot settings. Invite the bot with View Channels, Send Messages and Read Message History permissions. Mention it or reply to its messages. `.env` is loaded from the bot's directory regardless of your working directory.

`DISCORD_BOT_TOKEN` connects to Discord. `OPENAI_API_KEY` powers routing/presentation. `AGENTO_USER_ACCESS_TOKEN` is forwarded to your API. The API alone checks login, expiry and permissions. Leave the user token blank to test the API's 401 handling.

`DISCORD_TEST_USER_ID` binds the single environment token to your Discord account. Other users get their own sessions without that token. For a multi-user integration, replace `base()`'s environment lookup with your application's trusted per-user token resolver. This binding does not decode or verify the token.

## Behavior

- Mention the bot and ask for categories, services, availability or your appointments.
- Choose from the dropdown. Lists over 25 items have previous/next buttons. In chat, `2` and `٢` mean the second displayed option; `runtime.select()` still uses the real ID.
- Missing inputs are returned by V2 and collected in the following messages.
- Booking shows a confirmation; only the owner can use its buttons. Each button carries the exact confirmation ID. Old controls and replies remain identifiable as stale and cannot affect newer requests.
- Long output is split across Discord messages without silently cutting the result. Controls are attached only to the final chunk.
- `/tools` lists tools, `/cancel` cancels the pending flow, `/reset` clears the conversation and retained credential. The configured environment token is supplied again on the next request.
- `AGENTO_DEBUG=true` prints sanitized runtime events. API 401 and 403 are shown as login/permission rejections.

## Match the real API contract

The YAML keeps the original `http://localhost:3000/api/...` paths. `AGENTO_API_BASE_URL` overrides only the tool URL base; it does not change the model provider URL. For HTTPS deployment remove the HTTP opt-in.

Selection shapes are explicit and differ by endpoint. They must be checked against sanitized staging responses before live booking.

| List                           | ID field       | Label field  |
| ------------------------------ | -------------- | ------------ |
| Categories (bare array)        | `$.id`         | `$.name_ar`  |
| Groups (`$.groups`)            | `$.id`         | `$.name_ar`  |
| Search/services (`$.services`) | `$.id`         | `$.name_ar`  |
| Variants (bare array)          | `$.id`         | `$.name_ar`  |
| Availability                   | `$.slot_token` | `$.start_at` |

The availability label path is a declared example contract, not a claim about your server: change it if the actual response uses `starts_at`, `label`, or another name. AGENTO does not guess field names. The real API response was not supplied with this repository.

Category browsing uses `/api/catalog/categories/{slug}/groups`; the slug comes from the selected category. Booking is intentionally single-service: a trusted service selection filters variants, then availability supplies the slot token. Booking sends that token, optional notes, and the constants `payment_provider: none`, `currency: SAR`, `hold_minutes: 15`. Write requests make one attempt; enable retry/idempotency only after verifying backend support. Multi-service requests are not implemented by this example.

For natural-language model testing use the bot normally. To inspect the same API without Discord, use the console examples documented in [the Arabic setup guide](../../docs/RUNNING_AR.md).
