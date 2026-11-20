# Chat: Knowledge & Skills

## Nguyên nhân lỗi `Cannot read properties of undefined (reading 'startsWith')`

`scoreKnowledge()` nhận `KnowledgeLike`, trong đó `reason` là field bắt buộc nhưng chỉ có sau khi qua `resolveKnowledge`. Hàm lại đọc `k.reason.startsWith("REPOSITORY")`. Chat truyền vào row thô từ `knowledge.list()` (`q<any>`, không có `reason`, `content` có thể null) nên TypeScript không bắt được, còn runtime thì crash.

Cách sửa:

- Tách contract: `ScorableKnowledge` gồm key, title, category, content, scope_type, metadata, là các field mọi row knowledge đều có. Scorer chỉ đọc những field này; độ ưu tiên REPOSITORY lấy từ `scope_type`, kết quả tương đương với cách cũ.
- `KnowledgeLike` (đã resolve) = `ScorableKnowledge` + `reason`.
- Các chỗ ép kiểu (`as any`, `reason` giả trong contextTools/learning, `as never` trong chat memory) đã bỏ.
- Chat không còn dùng `knowledge.list()` để retrieval.

## Một pipeline cho cả Chat và Workflow

`src/chat/knowledge.ts`: `knowledge.candidates` (owner-visible, version đang hiệu lực) → `visibleKnowledge` (quyền repository) → `resolveKnowledge` (scope, applicability, expiry, supersession, precedence) → `scoreKnowledge` / `planKnowledge` (progressive disclosure). Ngữ cảnh resolve: `workflowKey/stepKey = "chat"`, repositories = scope của hội thoại.

- **Đầu mỗi turn** (trước mọi tool): item liên quan đi qua planner. Policy enforced và business rule liên quan nằm inline; item liên quan khác là một dòng index (đọc toàn văn bằng `knowledge.get`). `task_memory` không nằm trong pipeline này: chat memory có recall riêng, còn memory của run cần provenance repo.
- **`knowledge.search`**: chung scorer với workflow, có lọc theo category (`agent_skill` để tìm skill). Supporting file của skill không xuất hiện như một hit.
- **`knowledge.get`**: toàn văn theo version đang hiệu lực, phân trang 18k ký tự. Kèm source (`repo:path`), `effective_from`, thông báo supersede kèm key thay thế, và external notice. Đọc một skill là kích hoạt nó, kèm danh sách supporting documents đọc được bằng cùng tool. Item ngoài scope của hội thoại vẫn đọc được nếu visible, và được ghi rõ là ngoài scope.
- **Skill**: vẫn giữ quy tắc opt-in của registry khi tự áp dụng, nhưng tìm được khi user cần.
- **Song ngữ**: `termsOf` / `requestTerms` trong `context/plan.ts` (dùng chung với workflow) map cụm từ nghiệp vụ tiếng Việt (hoàn tiền, đơn hàng, bảo hành, thanh toán, vận chuyển, tồn kho, khuyến mãi, hoá đơn, khách hàng, sản phẩm, đổi trả) sang khái niệm tiếng Anh ở cả hai phía, kèm từ đồng nghĩa tiếng Anh. Không dùng vector DB, không gọi LLM.

## Semantic retrieval (tuỳ chọn)

Khi bật `retrieval.semantic` ([ADR 0001](adr/0001-go-backend-semantic-retrieval.md) §7), `src/retrieval/semantic.ts` gọi Go service với đúng tập item mà pipeline trên đã cho phép (`source_ids`); hit có `version` khác item đã load bị bỏ (embedding cũ), hit ngoài tập bị bỏ. Thứ hạng ngữ nghĩa chỉ sắp xếp lại, không bao giờ thêm item:

- **Luật fusion** (`fuseRanks` / `planKnowledge` trong `context/plan.ts`): Reciprocal Rank Fusion k = 60, `fused = 1/(60 + lexical_rank) + 1/(60 + semantic_rank)`; item vắng mặt trong một danh sách không nhận điểm từ danh sách đó. Chỉ áp dụng cho item không mandatory; mandatory (enforced, business rule, assigned, re-execution) giữ nguyên thứ tự và miễn budget, unverified suggestion vẫn ghim ở index. Tie-break theo key như cũ. `prompt_plan.knowledge` ghi thêm `semantic_rank` và `fused`; `why` ghi "semantic similarity rank N".
- **Điểm dùng**: workflow `resolveContext` (cùng `rankText` với lexical), agent `search_knowledge` và `platform.search_knowledge` / `search_task_memory` / `get_business_rules` (trên snapshot đã kiểm tra, có thêm `semantic_similarity`), chat `knowledgeForTurn` / `knowledge.search` (sau `discoverable()`), chat `recallMemories` (chỉ memory.chat.* của chính owner). Trong search và chat, hit ngữ nghĩa có thể đưa item lexical score 0 vào kết quả, nhưng chỉ item đã nằm trong tập được phép.
- **Fallback**: tắt, thiếu token, timeout (`AbortSignal.timeout` + `X-Request-Timeout-Ms`), non-2xx hoặc body sai contract → lexical, log tối đa một lần mỗi phút cho mỗi lý do, đếm trong `GET /api/admin/retrieval/status`. Nội dung retrieve vẫn là ngữ cảnh không tin cậy như trước.
- **Đánh giá**: `npm run eval:retrieval` (fixture `test/fixtures/retrieval-eval.json`).

## Hiển thị và trích dẫn

- Event `knowledge.applied` kèm danh sách {key, version, title, category, owner, reason, disclosure, sources}.
- Trace của turn có item `knowledge` (applied / suggested / read): panel suy luận hiển thị "Knowledge: title vN (…)".
- Item inline thành citation `knowledge:<key>@v<version>` trên câu trả lời. `knowledge.get` thành công cũng được ghi vào trace.

## An toàn

Knowledge, skill và memory chỉ là hướng dẫn. Policy chat ghi rõ chúng không cấp tool, operation hay permission, và không override policy hay security policy. Quyền thực thi vẫn do registry tool, allowlist QC và luồng xác nhận quyết định (có test: một item knowledge khẳng định "được publish production" không thay đổi `kafkaPublishTarget`).

## Kiểm thử

- Unit `test/chat-knowledge.test.ts`: tái hiện lỗi (row không có `reason`), planner, song ngữ, không map nhầm tên người.
- Integration `test/chat-knowledge.integration.ts`:
  - `knowledge.search` chạy được trong một turn chat;
  - version đang hiệu lực (version tương lai không áp dụng);
  - supersession;
  - private của user khác và knowledge của repo không đọc được đều bị ẩn, kể cả khi đọc bằng key;
  - skill: tìm được, kích hoạt khi đọc, supporting document;
  - turn: rule tiếng Việt được áp dụng inline cho câu hỏi tiếng Anh, có trace/version/citation;
  - knowledge không mở được production.
