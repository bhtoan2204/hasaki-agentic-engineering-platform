# Chat: tool tích hợp, thao tác QC có xác nhận, memory, optimistic UI

## Tool tích hợp (dùng lại registry, không viết lại)

Chat thêm nhóm `integrations` (mode ASK, INVESTIGATE) gồm 3 tool gateway đi qua `src/agent/toolRegistry.ts`, cùng registry mà workflow và MCP bridge đang dùng:

- `tools.search`: `listTools`, kèm availability và cờ read_only.
- `tools.describe`: `describeTool`, trả JSON schema.
- `tools.call`: tool read-only chạy ngay qua `callTool`, mode `analysis`, trong execution context của owner (load credential cá nhân). Tool thay đổi state không chạy mà trở thành operation chờ xác nhận.

Các tool gắn với run (`run.*`) bị ẩn trong chat. `ToolCallContext.runId` giờ là `number | null`.

Routing: yêu cầu vận hành (kafka, publish, topic, tạo đơn, bảo hành…) mở tool loop (AUTO → INVESTIGATE, để dùng được cả DB/log khi kiểm tra downstream). Policy bắt model tự tìm payload (`kafka.read_messages` trên topic, knowledge, code consumer) thay vì hỏi user.

## Kafka publish (QC)

- `publishMessage` / `kafkaPublishTarget` trong `src/integrations/kafka.ts`. Đây là request ghi duy nhất của client Kafka UI: `POST /api/clusters/{cluster}/topics/{topic}/messages` (`sendTopicMessages`, body `CreateTopicMessage`).
- Cấu hình `kafka.publishAllow: [{cluster, topics}]`. Mặc định rỗng, tức publish bị tắt. Topic kết thúc bằng `*` là prefix.
- Luôn từ chối nếu base URL không phải QC, hoặc cluster/topic có dạng production (`prod`, `production`, `live`, `prd`). Kể cả khi đã được allowlist.
- Tool `kafka.publish`: `readOnly: false`, `confirm: true`, có `preflight`. `callTool` từ chối mọi lời gọi không mang `confirmedOperation`, nên agent workflow (coding) và MCP không thể publish; workflow catalog cũng không liệt kê tool này.
- Kết quả: `published: true, downstream_verified: false` kèm lời nhắc kiểm tra consumer lag, DB hoặc log. Publish thành công không có nghĩa là nghiệp vụ đã xử lý xong.

## Vault set_key (QC)

- Tool `vault.set_key {path, key, value}` (`setVaultKey` / `vaultWriteTarget` trong `src/integrations/vault.ts`): đổi đúng một key của một secret KV v2 đã tồn tại. `readOnly: false`, `confirm: true`, không preauthorized, nên chỉ chạy qua `chat_operations`.
- Cấu hình `vault.writeAllow: [{path, keys}]`. Mặc định `[{path: "*", keys: ["*"]}]`: mọi path và key ở QC (Vault production vẫn bị chặn), mỗi lần ghi vẫn phải xác nhận. Đặt `[]` để tắt ghi, hoặc thu hẹp theo path/key. `path` kết thúc bằng `*` là prefix; `keys` khớp chính xác, phân biệt hoa thường, `"*"` là mọi key.
- Chỉ QC: từ chối nếu host của `vault.baseUrl` không phải QC hoặc có dạng production, và từ chối path có dạng production hoặc chứa `..`. Vault production chỉ đọc (`vault.list`, `vault.keys`).
- Ghi bằng đọc-gộp-ghi: đọc secret (version `v`), gộp key mới rồi `POST {mount}/data/{path}` kèm `options.cas = v`. Key khác giữ nguyên và ghi đè do race bị chặn. Token chỉ cần `create`/`update` trên `{mount}/data/*`, không cần `patch` (PATCH của KV v2 đòi capability `patch` riêng nên dễ bị 403). Mount KV v1 và secret chưa tồn tại bị từ chối.
- Preflight đọc version hiện tại của secret và đưa vào khoá idempotency (`operationKeyFor`), nên đổi A→B→A là ba operation khác nhau; gửi lặp khi version chưa đổi vẫn bị chặn là `duplicate`.
- Preflight hỏi `sys/capabilities-self` cho path dữ liệu: token không có `update` thì bị từ chối ngay lúc đề xuất, kèm danh sách quyền hiện có. Nếu không hỏi được (403/404) thì bỏ qua bước này.
- Giá trị cũ không bao giờ được đọc ra kết quả. Kết quả: `written: true, version, downstream_verified: false`; service vẫn cần restart/sync để nhận giá trị mới. Model đọc lại bằng `vault.keys` rồi `operations.verify`.
- Chưa chạy thử với Vault QC thật: policy của token (cần `create`/`update` trên path) chưa được xác minh.

## Argo CD restart (QC)

- Tool `argocd.restart {app, workload?, app_namespace?}` (`restartTarget` / `restartWorkload` trong `src/integrations/argocd.ts`): gọi action `restart` của Argo CD (`POST /api/v1/applications/{app}/resource/actions/v2`) cho một Deployment/StatefulSet/DaemonSet. `readOnly: false`, `confirm: true`, không preauthorized.
- Chỉ QC: từ chối nếu host Argo CD không phải QC, app hoặc namespace có dạng production. App có nhiều workload thì phải truyền `workload`.
- Preflight đọc resource tree và đưa thời điểm tạo ReplicaSet/Pod mới nhất vào `version` của target (khoá idempotency, `operationKeyFor`), nên restart lần sau của cùng workload là operation mới; gửi lặp khi chưa có gì đổi vẫn bị chặn là `duplicate`.
- Kết quả: `restarted: true, downstream_verified: false`. Model kiểm tra bằng `argocd.app_pods` (pod mới, restart, health) và `argocd.pod_logs` rồi `operations.verify`.
- Cần token Argo CD của user có quyền action `restart` (RBAC). Chưa chạy thử với Argo CD QC thật.

## Operation (migration 078)

`chat_operations`: lưu `pending → executing → succeeded | failed | unknown | rejected | expired | duplicate`.

1. Model gọi `tools.call` với tool mutating. `proposeOperation` validate schema, kiểm tra availability và preflight (allowlist, chặn production), rồi lưu `pending` (TTL 15 phút) và audit `chat.operation.propose`. Không có gì được thực thi.
2. Owner bấm Xác nhận hoặc Từ chối (`POST /api/chat/operations/:id/confirm|reject`, chỉ owner, các user khác nhận 404). Khi xác nhận, hệ thống validate lại toàn bộ (allowlist có thể đã đổi), rồi chuyển `pending → executing` bằng một UPDATE có điều kiện.
3. Idempotency: key = sha256(owner, tool, args đã canonical hoá).
   - Unique index `(owner_id, idempotency_key) WHERE status IN (executing, succeeded, unknown)`, nên double-click, request đồng thời hay proposal lặp lại đều không publish lần hai.
   - Header `x-idempotency-key` được gửi kèm event.
   - Timeout hoặc lỗi mạng → `unknown`: vẫn chặn lặp lại cho tới khi user kiểm tra topic.
4. Platform (không phải model) ghi kết quả vào hội thoại thành một tin nhắn assistant không gắn turn, và audit `chat.operation.execute/succeeded/failed/unknown/denied/reject`.
5. `arguments` dùng kiểu `JSON` chứ không phải JSONB, để payload được gửi đúng như đã đề xuất.

## Memory (dùng lại Knowledge Evolution)

`src/chat/memory.ts` ghi vào `knowledge_items`/`knowledge_versions` có sẵn: category `task_memory`, owner-private, key `memory.chat.<hash>`.

- Chạy nền sau `turn.completed` (`background`), không gọi LLM, chỉ dùng mẫu câu tất định.
- **Preference / correction**: câu user tự gõ rõ ràng ("nhớ là…", "từ giờ…", "luôn/đừng…", "không phải … mà …", "remember…", "from now on…"). Câu hỏi bị bỏ qua.
- **Procedure đã xác minh**: sau một operation `succeeded`, lưu tool, target và _tên field_ của payload (không lưu giá trị).
- **Business rule** ("Rule: …", "Quy tắc: …"): không thành memory mà tạo `knowledge_proposals` (source_kind `chat`, shared, pending) để đi qua luồng duyệt hiện có.
- Không bao giờ học: output của model; text giống credential (`looksSecret`, từ khoá token/password/cookie…, chuỗi token dài); PII (`redactPii`); số định danh dài.
- Dedupe theo hash của câu đã chuẩn hoá; gặp lại thì tăng `count`.
- Recall: tối đa 5 memory đã bật của chính owner, xếp theo `scoreKnowledge` (preference luôn được xét), đưa vào prompt trong section `memory` dạng untrusted (không override policy). Workflow context bỏ qua các item này vì không có provenance repo.
- Quản lý: `GET /api/chat/memory`. Sửa, bật/tắt, xoá dùng các API knowledge có sẵn (`POST /api/knowledge/:key`, `/delete`, kiểm tra quyền owner). UI: nút "Bộ nhớ" trong chat.

## Optimistic UI

`web/src/pages/chatOptimistic.ts` (thuần, có test):

- Tin nhắn hiện ngay khi gửi, kèm placeholder assistant và trạng thái xử lý.
- Tin nhắn chờ biến mất đúng lúc một turn đã lưu mang cùng `client_message_id` (giờ được trả về trong `turns`). Vì vậy SSE, polling hay reconnect đều không làm tin nhắn hiện hai lần.
- Gửi lỗi: giữ nguyên text kèm nút Thử lại (gửi lại cùng id, server replay idempotent) và nút Bỏ.

## Kiểm thử

- Unit `test/chat-operations.test.ts`: allowlist QC và chặn production, agent không gọi trực tiếp được `kafka.publish`, idempotency key, trích xuất memory (lọc secret/PII), routing, reconcile optimistic.
- Integration `test/chat-operations.integration.ts` (Kafka UI giả qua fetch):
  - đề xuất → xác nhận → đúng một lần publish (kể cả hai lần confirm đồng thời);
  - user khác không xác nhận được;
  - audit đầy đủ;
  - chặn trùng giữa các hội thoại;
  - production, ngoài allowlist hay sai schema đều bị từ chối trước khi có operation;
  - operation hết hạn không chạy; allowlist bị gỡ sau khi đề xuất vẫn bị chặn lúc xác nhận;
  - memory: dedupe, cô lập theo owner, recall, procedure không lưu giá trị, rule thành proposal, không học credential.

## Hạn chế

- Request produce chưa được chạy thử với Kafka UI QC thật. Contract lấy từ TypeSpec của kafbat; mã HTTP khi thành công và serde `String` chưa được xác minh trên môi trường thật.
- `partition` mặc định là 0 nếu không truyền: không phân phối theo key như producer thật.
- Quyền publish = owner + phiên Kafka UI cá nhân + allowlist; chưa có allowlist theo user/role.
- Trích xuất memory dựa trên mẫu câu nên bỏ sót cách nói khác. Chuỗi kiểu token dài (≥24 ký tự, có cả chữ và số) bị loại cho an toàn, nên có thể làm rơi cả tên topic dài.
