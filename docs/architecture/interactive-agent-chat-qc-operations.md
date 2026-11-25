# Chat: thao tác nghiệp vụ QC tự động và service discovery

Mở rộng `interactive-agent-chat-operations.md`. Không thêm orchestration layer: model tự chain các tool trong tool loop của chat (8 bước, 16 tool call mỗi turn), và mọi thao tác ghi đi qua `chat_operations`.

## Discovery

- **`argocd.service_endpoints`** (`argocd.ts`: `serviceEndpoints` / `endpointsFromArgo`), đọc từ Argo CD:
  - metadata của app, gồm source repo (map sang repository đã đăng ký nếu user đọc được);
  - resource tree, và manifest của Ingress, Gateway, HTTPRoute, GRPCRoute, Service;
  - kết quả trả về: hosts, paths, backends, gateways, ports, cluster DNS, external URLs, images.
- **`qc_http.openapi`**: tìm spec ở các path thường gặp, tóm tắt operation (method, path, summary, request schema). Không có spec thì dùng `knowledge.search` và `code.search` trên repo của service.
- **`qc_http.services`**: liệt kê host được phép, các thao tác pre-authorized, tên các auth profile (không có secret) và ngân sách thao tác mỗi turn.

## HTTP có kiểm soát (`src/integrations/qcHttp.ts`)

- **Đích**: chỉ host trong `qcHttp.hosts` (exact hoặc `*.suffix`; rỗng = tắt). Host có dạng production (`prod`/`production`/`live`/`prd`) hoặc thuộc `qcHttp.productionDomains` (mặc định `example.vn`) luôn bị từ chối, kể cả khi đã liệt kê.
- **Chống SSRF**: qua `safeHttp` (kiểm tra IP khi resolve DNS, chặn metadata và địa chỉ private trừ `internalHosts`, không follow redirect, TLS bật, giới hạn kích thước body).
- **Header**: caller không được tự đặt `Authorization`, `Cookie`, API key hay token.
- **Response**: field kiểu token/password/secret/cookie bị che.
- **Retry**: request ghi gửi đúng một lần, không retry, có kèm `Idempotency-Key` là key của operation. Timeout → operation `unknown`, chặn lặp lại. Request đọc retry tối đa 2 lần.

## Auth do backend quản lý

- `qcHttp.auth.<profile>`: login URL, body có `{{username}}`/`{{password}}`, đường dẫn tới token và TTL, header và scheme.
- Credential đọc từ **Vault** phía server (`vaultSecretValues`, không đăng ký làm tool), dùng token Vault của chính user.
- Token cache theo (user, profile), refresh khi hết hạn. Gặp 401 thì login lại và gửi lại đúng một lần (401 nghĩa là service chưa xử lý request nên gửi lại an toàn).
- Model chỉ biết tên profile. Test e2e kiểm tra password, token và field token trong response không xuất hiện trong prompt, tool result, operation, message hay event.

## Operation: pre-authorized và xác nhận

- `IntegrationTool.confirm`: tool chỉ chạy được qua operation. `preauthorized(args)`: operation chạy ngay, không cần user xác nhận từng lần, nhưng vẫn qua đúng đường confirm (validate lại, idempotency, audit `chat.operation.preauthorized`/`execute`).
  - `qc_http.request`: theo `qcHttp.preauthorized` (method + host + prefix path). DELETE luôn phải xác nhận.
  - `kafka.publish`: entry có `preauthorized: true` trong `kafka.publishAllow`.
- Ngân sách: tối đa `qcHttp.maxOperationsPerTurn` (mặc định 5) operation mỗi turn.
- Agent workflow/MCP không gọi trực tiếp được (`callTool` đòi có `confirmedOperation`).

## Xác minh kết quả

- `operations.verify {operation_id, evidence_seq, match}` do platform tự kiểm tra:
  - evidence là một tool call **read-only** thành công trong cùng turn, chạy **sau** khi operation kết thúc;
  - `match` (ví dụ mã đơn) phải có trong payload hoặc response của chính operation đó, và phải có trong kết quả đọc lại.
- Kết quả được lưu vào `chat_operations.verification` (migration 079), có audit và một tin nhắn do platform ghi.
- Policy cấm model khẳng định kết quả nghiệp vụ khi chưa verify. Response HTTP luôn kèm `business_verified: false`.

## Learning

Chỉ operation **đã xác minh** mới được học thành procedure (`learnProcedure`): tool, target (method/host/path hoặc topic), tên auth profile, tên field payload, và tool đã dùng để đọc lại. Không lưu giá trị, token hay credential.

## UI

Tiến trình tool đã stream sẵn qua event `tool.*` và `operation.updated`. Thẻ operation hiển thị "chạy tự động" và trạng thái xác minh.

## Kiểm thử

- Unit `test/qc-operations.test.ts`: allowlist / production / metadata / IP private / credential trong URL; header auth bị cấm; quy tắc pre-authorized (DELETE luôn phải xác nhận); che secret; tóm tắt OpenAPI; trích endpoint từ Argo CD.
- Integration `test/qc-operations.integration.ts` (service QC thật chạy trên 127.0.0.1, Argo CD giả):
  - chain đầy đủ: discovery → OpenAPI → tạo đơn (pre-authorized, token được inject, cache) → đọc lại → verify → bảo hành chờ xác nhận;
  - không lộ secret; học procedure không lưu giá trị;
  - chống trùng; ngân sách;
  - verify sai thì không được tính là đã xác minh;
  - chặn production, host ngoài allowlist, metadata;
  - 503 không retry; timeout → `unknown` và chặn lặp lại;
  - cô lập token theo user và refresh khi gặp 401.

## Hạn chế

- Login chỉ hỗ trợ JSON body và bearer token. OAuth client-credentials, cookie session hay mTLS chưa có.
- Credential lấy qua token Vault của user. Nếu user chưa kết nối Vault thì profile không dùng được.
- `serviceEndpoints` đọc tối đa 20 resource. Gateway listener không có hostname thì không suy ra được host.
- Chưa chạy với Argo CD, Vault hay service QC thật trong môi trường này.
