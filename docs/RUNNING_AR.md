# تشغيل AGENTO V2 على الـ API الفعلي

المشروع صار يستخدم `AgentRuntime` فقط. التوكن يُرسل في `Authorization: Bearer ...` والـ API عندك هو الذي يتحقق. لا يوجد `verifyToken` ولا إعداد JWKS.

## 1. بناء المكتبة

من جذر النسخة الجديدة، داخل PowerShell:

```powershell
npm ci
npm run build
```

البناء يمسح `dist` القديم أولًا، حتى لا تبقى ملفات V1 من بناء سابق.

## 2. تشغيل Discord

```powershell
cd examples/discord-bot
npm ci
Copy-Item .env.example .env
```

افتح `.env` وعبّئ:

```dotenv
DISCORD_BOT_TOKEN=توكن_البوت
OPENAI_API_KEY=مفتاح_OpenAI
AGENTO_API_BASE_URL=http://localhost:3000
AGENTO_ALLOW_INSECURE_HTTP=true
AGENTO_USER_ACCESS_TOKEN=توكن_المستخدم_من_API_عندك
DISCORD_TEST_USER_ID=معرف_حسابك_على_Discord
AGENTO_DEBUG=true
```

شغّل API عندك على العنوان المحدد، ثم:

```powershell
npm run dev
```

فعّل Message Content Intent للبوت. اعمل mention للبوت أو رد على رسالته. `/tools` يعرض الأدوات، `/cancel` يلغي الطلب الحالي، و`/reset` يمسح الجلسة. التوكن الموجود في البيئة يُمرّر مجددًا في الطلب التالي.

معرف Discord يربط توكن الاختبار بحسابك حتى لا يستخدم شخص آخر توكنك. هذا ليس تحققًا من JWT. يمكن ترك توكن المستخدم ومعرف Discord فارغين لاختبار رد الـ API عند غياب التوكن.

رسالة `AUTH_REJECTED` تعني أن الـ API رد بـ401 أو403. إذا ظهر `CONFIG_SECRET_MISSING` فراجع مفتاح مزود النموذج. مفاتيح OpenAI وDiscord منفصلة عن توكن المستخدم.

## 3. إعداد شكل الـ API

المثال يحتفظ بمسارات الصالون الـ11 الموجودة سابقًا. راجع `examples/discord-bot/agent-config.yml` لحقول الردود:

- القوائم مفترضة كمصفوفة مباشرة: `items_path: $`، والمعرف `$.id` والاسم `$.name`.
- إذا كان الرد `{ data: [...] }` استخدم `items_path: $.data` في الاختيارات والـ dependencies.
- قائمة المواعيد تعلن `$.slot_token` للمعرف و`$.start_at` للنص. عدّل مسار النص لاسم الحقل الفعلي عندك.
- عند HTTPS احذف `AGENTO_ALLOW_INSECURE_HTTP=true` أو اجعله `false`.

هذه المسارات موثقة في المثال؛ يلزم مطابقتها مع رد API عندك لأن ردوده الفعلية غير موجودة في المستودع. إذا اختلفت، سيظهر خطأ mapping/selection بدل اختراع البيانات.

## 4. اختبار المحادثة من الطرفية

من جذر المشروع، دون Discord:

```powershell
$env:AGENTO_API_BASE_URL = "http://localhost:3000"
$env:AGENTO_ALLOW_INSECURE_HTTP = "true"
$env:OPENAI_API_KEY = "ضع مفتاحك"
$env:AGENTO_USER_ACCESS_TOKEN = "ضع توكن المستخدم"
npm run example:console
```

هذا يستخدم النموذج الفعلي ويستدعي API الفعلي. اكتب طلبك، ثم اختر المعرف عندما تظهر الاختيارات. عند `needs_confirmation` اكتب `CONFIRM` لتنفيذ العملية. `/exit` للخروج.

## 5. اختبار HTTP دون استدعاء النموذج

شغّل نفس المثال مع `direct: true`:

```powershell
npm run example:console -- --direct
```

داخل الطرفية:

```text
/tools
/invoke get-categories {}
/invoke get-my-appointments {"limit":10}
/invoke book-appointment {"date":"2026-10-01","notes":"اختبار يدوي"}
```

`invoke` ينفذ المكتبة وHTTP فعليًا دون model أو provider وهمي. العمليات التي تغيّر البيانات تحتاج `CONFIRM` قبل التنفيذ. عند نقص مدخلات في وضع direct، أعد `/invoke` بالمدخلات اللازمة؛ وضع المحادثة يجمع المدخلات تدريجيًا.

## الانتقال من النسخة السابقة

- `AgentHandler` أزيل، والاستيراد الافتراضي والمسمّى أصبحا `AgentRuntime`.
- YAML الإصدار القديم لا يعمل مباشرة؛ الأمثلة أصبحت `version: "2"`.
- `chat({ authToken })` أصبح `chat({ auth: { token } })`.
- `invokeEndpoint({ endpointId, payload })` أصبح `invoke({ tool, arguments })`.
- تعامل مع `completed`, `needs_input`, `needs_selection`, `needs_confirmation`, `error`.
- رد «نعم» وحده لا ينفّذ عملية؛ التطبيق يستدعي `confirm()` بالمعرف المعاد له.

راجع [مثال Discord](../examples/discord-bot/README.md) و[عقد الإعدادات](v2/CONFIGURATION.md).
