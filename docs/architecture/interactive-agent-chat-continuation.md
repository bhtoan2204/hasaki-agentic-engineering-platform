# Chat: routing theo ngữ cảnh và tiếp tục yêu cầu dang dở

## Lỗi đã sửa

`chatRepository.latestTurnWithUser()` trả về turn mới nhất có tin nhắn user. Lúc routing, đó chính là **turn hiện tại** (tin nhắn user đã được lưu), nên `priorRoute` luôn là `null` và tính năng follow-up không bao giờ chạy. Giờ hàm nhận thêm `beforeTurnId` và chỉ lấy turn đứng trước.

## Continuation state (migration 081)

`chat_conversations.continuation` lưu yêu cầu chưa xong của hội thoại.

- Do platform suy ra sau **mỗi turn** (`recordContinuation`) từ dữ liệu đã ghi nhận: tool call, operation, failure, `stop_reason`. Không lấy từ lời model.
- Nội dung: `goal`, `route`, `effective_mode`, `completed` (tool đã chạy thành công, kèm evidence ref), `blockers` (tool lỗi hoặc không khả dụng, turn fail, hết ngân sách, operation đang chờ, chưa rõ kết quả, fail, hoặc chạy rồi nhưng chưa verify), `operations`, `turns`.
- Mở khi một turn có tool để lại blocker. Đóng khi lần resume hoàn tất sạch.
- Một turn chủ đề mới chạy sạch **không** xoá yêu cầu cũ còn dang dở. Turn trả lời trực tiếp không thay đổi gì. State quá 24 giờ thì không resume nữa.

## Nhận diện follow-up (`continuesGoal`)

Quyết định theo ngữ cảnh, không theo danh sách cụm từ:

- **Resume** khi tin nhắn có ≥ 30% từ trùng với goal (user nhắc lại hoặc thu hẹp yêu cầu), hoặc tin nhắn ngắn (≤ 6 từ) và không có tín hiệu routing riêng. Ví dụ: "làm lại đi", "redo it", "connected now", "tiếp tục".
- **Chủ đề mới** khi tin nhắn có ý định riêng rõ ràng và ít liên quan tới goal. Mode chọn tay hoặc `@mention` cũng là ngữ cảnh mới.
- Tin nhắn ngắn nhưng không liên quan (ví dụ "cảm ơn") vẫn đi đường resume. Prompt dặn model trả lời bình thường và không chạy tool cho yêu cầu cũ. Không tốn thêm lời gọi model để phân loại.

## Khi resume

- Route và mode lấy từ goal, bật tool, `routing.source = "context"`, và `continued: true` lưu trong `turn.routing`.
- Refresh session integration của owner (`loadPersonalIntegrations(true)`) rồi kiểm tra lại các tool từng chặn. Prompt ghi rõ tool nào "NOW AVAILABLE", tool nào vẫn chưa dùng được và vì sao.
- Section `continuation` trong prompt gồm: goal, những gì đã làm, blocker, operation kèm trạng thái, và tối đa 6 evidence cũ (bị cắt bớt, chỉ của repo còn đọc được) để dùng lại thay vì đọc lại.
- Model được dặn thử tool khác cũng được phép dùng trước khi bỏ cuộc.
- Side effect không bị lặp: operation trùng thì dùng lại bản đang chờ, hoặc bị từ chối là duplicate (idempotency có sẵn). Các giới hạn QC, quyền, xác nhận và verify giữ nguyên.

## Leo thang từ DIRECT_ANSWER

Ở đường direct, prompt cho phép model trả về đúng ` ```chat-escalate``` `. Runtime khi đó gắn tool catalog của mode ngay trong cùng turn (chỉ tốn thêm một lời gọi, và chỉ khi cần) và phát event `routing.completed` với `escalated: true`.

- Không áp dụng khi tool đã bị tắt vì hết ngân sách hoặc không tiến triển.
- Marker này không bao giờ được stream ra như câu trả lời.

## Kiểm thử

- Unit `test/chat-continuation.test.ts`:
  - follow-up tiếng Việt và tiếng Anh;
  - đổi chủ đề; mention; state cũ quá hạn;
  - các chuyển trạng thái (blocker, operation pending, đã chạy nhưng chưa verify, đã verify, turn fail, chủ đề mới chạy sạch);
  - marker escalate không bị stream ra.
- Integration `test/chat-continuation.integration.ts`:
  - routing nhận đúng turn trước;
  - kết nối Kafka xong rồi "kết nối rồi, làm lại đi" thì resume, refresh session, tool chạy được và state đóng;
  - escalation từ đường direct;
  - đổi chủ đề không resume và state cũ vẫn mở;
  - resume không tạo operation thứ hai và chỉ publish một lần.
